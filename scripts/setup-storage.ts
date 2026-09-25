// Creates the public image bucket in Supabase Storage (safe to run again).
//   npm run storage:setup
import { loadConfig } from '../src/config.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const config = loadConfig();
if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env first.');
  process.exit(1);
}
const root = config.SUPABASE_URL.replace(/\/$/, '');
const headers = {
  apikey: config.SUPABASE_SECRET_KEY,
  authorization: `Bearer ${config.SUPABASE_SECRET_KEY}`,
  'content-type': 'application/json',
};
// Public so the storefront can show images; only the API (with the secret key) can upload.
const settings = {
  public: true,
  file_size_limit: 5 * 1024 * 1024,
  allowed_mime_types: ['image/webp'],
};

const existing = await fetch(`${root}/storage/v1/bucket/${config.STORAGE_BUCKET}`, { headers });
const res = existing.ok
  ? await fetch(`${root}/storage/v1/bucket/${config.STORAGE_BUCKET}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(settings),
    })
  : await fetch(`${root}/storage/v1/bucket`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: config.STORAGE_BUCKET, name: config.STORAGE_BUCKET, ...settings }),
    });
if (!res.ok) {
  console.error(`Failed (${res.status}): ${await res.text()}`);
  process.exit(1);
}
console.log(
  `Bucket "${config.STORAGE_BUCKET}" is ready (${existing.ok ? 'updated' : 'created'}): public, WebP only, 5 MB per file.`,
);
