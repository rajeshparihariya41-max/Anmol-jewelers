const { createHash, timingSafeEqual } = require('node:crypto');

const CATALOG_PUBLIC_ID = 'anmol-catalog/live-catalog.json';
const MAX_LEGACY_PHOTO_BYTES = 3 * 1024 * 1024;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Publish-Token');
  res.setHeader('Access-Control-Max-Age', '600');
}

function getCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary is not configured on the server.');
  }
  return { cloudName, apiKey, apiSecret };
}

function getCatalogUrl(cloudName) {
  return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/raw/upload/${CATALOG_PUBLIC_ID}`;
}

function signUploadParams(params, apiSecret) {
  const canonical = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('sha1').update(`${canonical}${apiSecret}`).digest('hex');
}

function safePhotoKey(value) {
  const key = String(value || '');
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(key)) {
    throw new Error('Invalid photo key.');
  }
  return key;
}

function publishTokenMatches(req) {
  const expected = process.env.LIVE_PUBLISH_TOKEN;
  const supplied = req.headers['x-publish-token'];
  if (!expected || typeof supplied !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function uploadToCloudinary({ resourceType, publicId, file, filename, contentType, config }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = {
    public_id: publicId,
    overwrite: 'true',
    invalidate: 'true',
    timestamp,
  };
  const signature = signUploadParams(params, config.apiSecret);
  const form = new FormData();
  form.set('file', new Blob([file], { type: contentType }), filename);
  form.set('api_key', config.apiKey);
  form.set('public_id', publicId);
  form.set('overwrite', 'true');
  form.set('invalidate', 'true');
  form.set('timestamp', timestamp);
  form.set('signature', signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/${resourceType}/upload`,
    { method: 'POST', body: form },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[live-catalog] Cloudinary upload returned', response.status);
    throw new Error(payload?.error?.message || 'Cloudinary upload failed.');
  }
  return payload;
}

async function readRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 6 * 1024 * 1024) throw new Error('Request body is too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

async function handleGet(res) {
  const { cloudName } = getCloudinaryConfig();
  const url = `${getCatalogUrl(cloudName)}?t=${Date.now()}`;
  const upstream = await fetch(url, { cache: 'no-store' });
  if (upstream.status === 404) {
    return sendJson(res, 404, { error: 'Live catalogue abhi publish nahi hua hai.' });
  }
  if (!upstream.ok) {
    console.error('[live-catalog] Cloudinary read returned', upstream.status);
    return sendJson(res, 502, { error: 'Catalogue data load nahi ho paya.' });
  }
  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return sendJson(res, 502, { error: 'Catalogue data sahi format me nahi hai.' });
  }
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return sendJson(res, 200, data);
}

async function handlePost(req, res) {
  if (!publishTokenMatches(req)) {
    return sendJson(res, 401, { error: 'Publish permission nahi hai.' });
  }

  const body = await readRequestBody(req);
  const config = getCloudinaryConfig();

  if (body.action === 'signPhotoUpload') {
    const key = safePhotoKey(body.key);
    const publicId = `anmol-catalog/${key}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const params = {
      public_id: publicId,
      overwrite: 'true',
      invalidate: 'true',
      timestamp,
    };
    return sendJson(res, 200, {
      cloudName: config.cloudName,
      apiKey: config.apiKey,
      publicId,
      timestamp,
      signature: signUploadParams(params, config.apiSecret),
    });
  }

  if (body.action === 'uploadPhoto') {
    const key = safePhotoKey(body.key);
    const encoded = String(body.base64 || '').replace(/^data:[^;]+;base64,/i, '');
    if (!encoded || !/^[A-Za-z0-9+/=\s]+$/.test(encoded)) {
      return sendJson(res, 400, { error: 'Photo data invalid hai.' });
    }
    const file = Buffer.from(encoded, 'base64');
    if (!file.length || file.length > MAX_LEGACY_PHOTO_BYTES) {
      return sendJson(res, 413, { error: 'Photo bahut badi hai. App update karke dobara publish karein.' });
    }
    const uploaded = await uploadToCloudinary({
      resourceType: 'image',
      publicId: `anmol-catalog/${key}`,
      file,
      filename: `${key}.jpg`,
      contentType: 'image/jpeg',
      config,
    });
    return sendJson(res, 200, { url: uploaded.secure_url });
  }

  if (body.action === 'publish') {
    const data = body.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.items) || !data.items.length) {
      return sendJson(res, 400, { error: 'Catalogue me kam se kam ek item hona chahiye.' });
    }
    if (data.items.length > 1000) {
      return sendJson(res, 413, { error: 'Catalogue me bahut zyada items hain.' });
    }
    const file = Buffer.from(JSON.stringify(data), 'utf8');
    const uploaded = await uploadToCloudinary({
      resourceType: 'raw',
      publicId: CATALOG_PUBLIC_ID,
      file,
      filename: 'live-catalog.json',
      contentType: 'application/json',
      config,
    });
    return sendJson(res, 200, {
      jsonUrl: uploaded.secure_url || getCatalogUrl(config.cloudName),
      updatedAt: data.updatedAt || new Date().toISOString(),
      itemCount: data.items.length,
    });
  }

  return sendJson(res, 400, { error: 'Unsupported catalogue action.' });
}

module.exports = async function liveCatalogHandler(req, res) {
  setCorsHeaders(res);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    if (req.method === 'GET') return await handleGet(res);
    if (req.method === 'POST') return await handlePost(req, res);
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    console.error('[live-catalog] Request failed', error?.message || 'unknown error');
    const message = error?.message === 'Invalid photo key.'
      ? error.message
      : error?.message === 'Request body is too large.'
        ? error.message
        : 'Catalogue request complete nahi ho paya.';
    return sendJson(res, 500, { error: message });
  }
};