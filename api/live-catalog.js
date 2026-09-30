import { v2 as cloudinary } from "cloudinary";

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;
const publishToken = process.env.LIVE_PUBLISH_TOKEN;
const catalogPublicId = "anmol-catalog/live-catalog.json";
const photoFolder = "anmol-catalog/photos";

if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
}

const clean = (value) => (typeof value === "string" ? value.trim() : "");

const numberValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

const fallbackCatalog = {
  shopName: "Anmol Jewelers",
  ownerName: "Rajesh",
  phone: "9480405764",
  address: "#172 Nelagadaran Halli, Nagasandra Post, Bangalore 560073",
  instagramUrl: "https://www.instagram.com/anmol_jeweler?igsh=ZThxazRuYWMybWYz",
  categories: [],
  items: [],
  metalRates: {},
};

async function readPublishedCatalog() {
  const url = cloudinary.url(catalogPublicId, {
    resource_type: "raw",
    type: "upload",
    secure: true,
  });
  const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) return null;
  return await response.json();
}

async function getCatalog() {
  try {
    const published = await readPublishedCatalog();
    if (published) return published.catalog || published;
  } catch {
    // A missing live JSON should show the catalogue shell, not a server error.
  }
  return fallbackCatalog;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Publish-Token");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!cloudName || !apiKey || !apiSecret) {
    return res.status(500).json({
      error: "Cloudinary is not configured",
      code: "CLOUDINARY_ENV_MISSING",
    });
  }

  if (req.method === "GET") {
    try {
      return res.status(200).json({ catalog: await getCatalog() });
    } catch (error) {
      return res.status(502).json({
        error: "Unable to load catalogue from Cloudinary",
        code: "CLOUDINARY_REQUEST_FAILED",
      });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!publishToken || req.headers["x-publish-token"] !== publishToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};

  try {
    if (body.action === "uploadPhoto") {
      const { key, base64 } = body;
      if (!key || !base64) return res.status(400).json({ error: "key/base64 missing" });
      const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, "_");
      const result = await cloudinary.uploader.upload(`data:image/jpeg;base64,${base64}`, {
        public_id: `${photoFolder}/${safeKey}`,
        resource_type: "image",
        overwrite: true,
      });
      return res.status(200).json({ url: result.secure_url });
    }

    if (body.action === "publish") {
      const json = JSON.stringify(body.data ?? {});
      const result = await cloudinary.uploader.upload(
        `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`,
        { public_id: catalogPublicId, resource_type: "raw", overwrite: true },
      );
      return res.status(200).json({
        jsonUrl: result.secure_url,
        updatedAt: body.data?.updatedAt ?? null,
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Upload failed" });
  }
}