import { randomUUID } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { ApiError } from '../lib/errors.js';
import type { ImageStore } from './storage.js';

/**
 * Widths every uploaded image is stored at. The URL saved in the database is the largest one
 * (…-1200.webp); pages swap the suffix for a smaller size (see imgSrc in the storefront and admin).
 */
export const IMAGE_WIDTHS = [400, 800, 1200] as const;
const LARGEST = IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff']);

/**
 * Checks the file really is an image, straightens it (phone photos), strips metadata such as
 * GPS location, and stores it as WebP at each width. Returns the URL of the largest size.
 */
export async function storeImage(store: ImageStore, folder: string, input: Buffer): Promise<string> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new ApiError(400, 'NOT_AN_IMAGE', 'That file is not an image we can read. Use JPEG, PNG or WebP.');
  }
  if (!meta.format || !ACCEPTED.has(meta.format))
    throw new ApiError(400, 'NOT_AN_IMAGE', 'Use a JPEG, PNG or WebP image.');
  if ((meta.width ?? 0) < 300 || (meta.height ?? 0) < 300)
    throw new ApiError(400, 'IMAGE_TOO_SMALL', 'The image must be at least 300 × 300 pixels.');

  const base = `${folder}/${randomUUID()}`;
  let url = '';
  for (const width of IMAGE_WIDTHS) {
    const body = await sharp(input)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const stored = await store.put(`${base}-${width}.webp`, body, 'image/webp');
    if (width === LARGEST) url = stored;
  }
  return url;
}

/** Deletes every stored size of one of our image URLs. Other URLs (Pexels) are left alone. */
export async function deleteImage(store: ImageStore, url: string) {
  const path = store.pathOf(url);
  const m = path && /^(.*)-\d+\.webp$/.exec(path);
  if (!m) return;
  await store.remove(IMAGE_WIDTHS.map((w) => `${m[1]}-${w}.webp`));
}
