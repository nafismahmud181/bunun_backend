import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM for small secrets stored in the database (admin TOTP secrets, later provider API
// keys). Output: base64 of iv (12 bytes) | auth tag (16 bytes) | ciphertext.

function key(base64Key: string | undefined) {
  if (!base64Key) throw new Error('ADMIN_ENCRYPTION_KEY is not set');
  return Buffer.from(base64Key, 'base64');
}

export function encrypt(plain: string, base64Key: string | undefined) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(base64Key), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(sealed: string, base64Key: string | undefined) {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(base64Key), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
