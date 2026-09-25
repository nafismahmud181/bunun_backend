import type { Config } from '../config.js';

/** Where uploaded images live. Returns public URLs. */
export interface ImageStore {
  put(path: string, body: Buffer, contentType: string): Promise<string>;
  remove(paths: string[]): Promise<void>;
  /** The storage path of one of our public URLs, or null for any other URL (e.g. Pexels). */
  pathOf(url: string): string | null;
}

/**
 * Supabase Storage through its REST API, with the project's secret key. The bucket is public
 * (images are shown on the storefront), but only this server can write to it.
 */
export function supabaseStore(baseUrl: string, secretKey: string, bucket: string): ImageStore {
  const root = baseUrl.replace(/\/$/, '');
  const publicPrefix = `${root}/storage/v1/object/public/${bucket}/`;
  const auth = { apikey: secretKey, authorization: `Bearer ${secretKey}` };
  return {
    async put(path, body, contentType) {
      const res = await fetch(`${root}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': contentType,
          'x-upsert': 'true',
          'cache-control': 'public, max-age=31536000, immutable',
        },
        body: new Uint8Array(body),
      });
      if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return publicPrefix + path;
    },
    async remove(paths) {
      if (!paths.length) return;
      const res = await fetch(`${root}/storage/v1/object/${bucket}`, {
        method: 'DELETE',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      });
      if (!res.ok) throw new Error(`Storage delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    },
    pathOf: (url) => (url.startsWith(publicPrefix) ? url.slice(publicPrefix.length) : null),
  };
}

/** In-memory store for tests. */
export function memoryStore(): ImageStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  const prefix = 'https://storage.test/';
  return {
    files,
    async put(path, body) {
      files.set(path, body);
      return prefix + path;
    },
    async remove(paths) {
      for (const p of paths) files.delete(p);
    },
    pathOf: (url) => (url.startsWith(prefix) ? url.slice(prefix.length) : null),
  };
}

export function createImageStore(config: Config): ImageStore | null {
  if (config.STORAGE_DRIVER === 'memory') return memoryStore();
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) return null; // uploads disabled
  return supabaseStore(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, config.STORAGE_BUCKET);
}
