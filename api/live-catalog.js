// ─── Live Catalog API (Vercel serverless function) ─────────────────────
// File: api/live-catalog.ts   (project ROOT me "api" folder banao, isme rakho)
// Vercel ise khud https://<domain>/api/live-catalog bana dega. Koi adapter nahi chahiye.
//
// Vercel env vars (project Settings → Environment Variables):
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
//   LIVE_PUBLISH_TOKEN
// Aur: pnpm add cloudinary
import { v2 as cloudinary } from 'cloudinary';

// Vercel Node runtime me Buffer hota hai; tsc ke liye local type
// (tsconfig me kuch badalne ki zaroorat nahi)
declare const Buffer: {
  from(data: string, encoding: 'utf8' | 'utf-8'): { toString(encoding: 'base64'): string };
};

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const PUBLISH_TOKEN = process.env.LIVE_PUBLISH_TOKEN;
const JSON_PUBLIC_ID = 'anmol-catalog/live-catalog.json';
const PHOTO_FOLDER = 'anmol-catalog/photos';

export default async function handler(req: any, res: any) {
  // Browser se seedha taaza JSON (zaroorat ho to)
  if (req.method === 'GET') {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    if (!cloud) return res.status(500).json({ error: 'Not configured' });
    return res.redirect(`https://res.cloudinary.com/${cloud}/raw/upload/${JSON_PUBLIC_ID}`);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.headers['x-publish-token'];
  if (!PUBLISH_TOKEN || token !== PUBLISH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  try {
    // ── Photo upload (signed, overwrite allowed) ──
    if (body.action === 'uploadPhoto') {
      const { key, base64 } = body;
      if (!key || !base64) return res.status(400).json({ error: 'key/base64 missing' });
      const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
      const result = await cloudinary.uploader.upload(`data:image/jpeg;base64,${base64}`, {
        public_id: `${PHOTO_FOLDER}/${safeKey}`,
        resource_type: 'image',
        overwrite: true,
      });
      return res.status(200).json({ url: result.secure_url });
    }

    // ── Live JSON publish (signed, overwrite allowed) ──
    if (body.action === 'publish') {
      const json = JSON.stringify(body.data ?? {});
      const result = await cloudinary.uploader.upload(
        `data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}`,
        { public_id: JSON_PUBLIC_ID, resource_type: 'raw', overwrite: true },
      );
      return res.status(200).json({ jsonUrl: result.secure_url, updatedAt: body.data?.updatedAt ?? null });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e: any) {
    console.error('[live-catalog] error', e);
    return res.status(500).json({ error: e?.message || 'Upload failed' });
  }
}
