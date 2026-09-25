import { randomBytes } from 'node:crypto';
import { generate, generateSecret } from 'otplib';
import type { AdminRole } from '../../src/generated/prisma/client.js';
import type { buildApp } from '../../src/app.js';
import { encrypt } from '../../src/lib/crypto.js';
import type { Db } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/services/admin-auth.js';

type App = Awaited<ReturnType<typeof buildApp>>;
export const TEST_KEY = randomBytes(32).toString('base64');

/**
 * Creates an admin with two-factor authentication already set up and signs in.
 * Returns the session token.
 */
export async function signedInAdmin(app: App, db: Db, email: string, role: AdminRole) {
  const secret = generateSecret();
  await db.adminUser.create({
    data: {
      email,
      name: `Test ${role}`,
      role,
      passwordHash: await hashPassword('test-password'),
      totpSecret: encrypt(secret, TEST_KEY),
      totpEnabled: true,
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email, password: 'test-password' },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/2fa',
    headers: { authorization: `Bearer ${login.json().token}` },
    payload: { code: await generate({ secret }) },
  });
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.body}`);
  return res.json().token as string;
}

/** Builds a multipart/form-data body with one file (and optional text fields). */
export function multipart(file: Buffer, filename: string, contentType: string, fields: Record<string, string> = {}) {
  const boundary = '----bunun' + randomBytes(8).toString('hex');
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
