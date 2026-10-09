import { hash, verify as verifyPassword } from '@node-rs/argon2';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import type { AdminSessionStage, AdminUser } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { permissionsFor } from '../lib/permissions.js';
import type { Db } from '../lib/prisma.js';

export const PRE_2FA_TTL_MS = 10 * 60_000; // time to enter the authenticator code
export const SESSION_TTL_MS = 12 * 3600_000; // longest a session can last
export const IDLE_TTL_MS = 2 * 3600_000; // signed out after this long without activity
export const MAX_FAILED_LOGINS = 10; // wrong passwords before the account is locked…
export const LOCK_MS = 15 * 60_000; // …for this long
export const MAX_FAILED_CODES = 5; // wrong codes before the half-signed-in session is dropped
const ISSUER = 'Bunon Admin';

export interface RequestContext {
  ip: string;
  userAgent?: string;
}

// Verified against when the email doesn't exist, so both cases take the same time.
const DUMMY_HASH = hash('not-a-real-password-' + randomToken());

export const hashPassword = (password: string) => hash(password);

export function adminView(a: AdminUser) {
  return { id: a.id, email: a.email, name: a.name, role: a.role, permissions: permissionsFor(a.role) };
}

async function newSession(db: Db, adminId: number, stage: AdminSessionStage, ctx: RequestContext) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + (stage === 'active' ? SESSION_TTL_MS : PRE_2FA_TTL_MS));
  await db.adminSession.create({
    data: { tokenHash: sha256(token), adminId, stage, expiresAt, ip: ctx.ip, userAgent: ctx.userAgent?.slice(0, 300) },
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

const WRONG_LOGIN = () => new ApiError(401, 'INVALID_LOGIN', 'Email or password is incorrect.');

/**
 * Counts a wrong password or a wrong two-factor code against the account (atomically, so guesses
 * sent in parallel all count) and locks it for 15 minutes at MAX_FAILED_LOGINS. Codes count too, so
 * someone who knows the password can't try codes forever by signing in again from new addresses.
 */
async function countFailure(db: Db, adminId: number, action: string, ctx: RequestContext) {
  const { failedLogins } = await db.adminUser.update({
    where: { id: adminId },
    data: { failedLogins: { increment: 1 } },
    select: { failedLogins: true },
  });
  const lock = failedLogins >= MAX_FAILED_LOGINS;
  if (lock)
    await db.adminUser.update({
      where: { id: adminId },
      data: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) },
    });
  await audit(db, { adminId, action: lock ? 'auth.locked' : action, ip: ctx.ip });
}

/**
 * Checks an authenticator code and uses it up: a code is accepted once only (its TOTP time step is
 * stored as totpLastStep). The step is claimed atomically, so of two requests racing with the same
 * code only one succeeds.
 */
async function claimCode(
  db: Db,
  key: string | undefined,
  admin: AdminUser,
  code: string,
  extra: { totpEnabled?: boolean; lastLoginAt?: Date } = {},
) {
  if (!admin.totpSecret) return false;
  const result = await verifyTotp({ secret: decrypt(admin.totpSecret, key), token: code, epochTolerance: 30 });
  const step = result.valid && 'timeStep' in result ? result.timeStep : null;
  if (step === null) return false;
  const { count } = await db.adminUser.updateMany({
    where: { id: admin.id, active: true, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { ...extra, totpLastStep: step, failedLogins: 0 },
  });
  return count === 1;
}

/**
 * Asks a signed-in admin for a fresh authenticator code before a dangerous action. A wrong code
 * counts towards the same 15-minute lock as wrong sign-in codes.
 */
export async function confirmWithCode(
  db: Db,
  key: string | undefined,
  admin: AdminUser,
  code: string,
  ctx: RequestContext,
) {
  if (admin.lockedUntil && admin.lockedUntil > new Date())
    throw new ApiError(423, 'ACCOUNT_LOCKED', 'Too many wrong attempts. Try again in 15 minutes.');
  if (await claimCode(db, key, admin, code)) return;
  await countFailure(db, admin.id, 'auth.2fa_failed', ctx);
  throw new ApiError(400, 'INVALID_CODE', 'That code is not right. Wait for the next one and try again.');
}

/**
 * Step 1: email and password. Returns a short-lived token for step 2, plus the authenticator
 * setup details (otpauth URL and secret) if two-factor authentication isn't set up yet.
 */
export async function login(db: Db, key: string | undefined, email: string, password: string, ctx: RequestContext) {
  const admin = await db.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!admin) {
    await verifyPassword(await DUMMY_HASH, password);
    throw WRONG_LOGIN();
  }
  const locked = !!admin.lockedUntil && admin.lockedUntil > new Date();
  if (!(await verifyPassword(admin.passwordHash, password))) {
    // While locked, a wrong password gets the same answer as an unknown email, so the lock
    // doesn't reveal which emails are staff accounts; only the right password learns of it.
    if (!locked) await countFailure(db, admin.id, 'auth.login_failed', ctx);
    throw WRONG_LOGIN();
  }
  if (locked) throw new ApiError(423, 'ACCOUNT_LOCKED', 'Too many wrong attempts. Try again in 15 minutes.');
  if (!admin.active) throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
  // The failure count is reset only after the two-factor code too (verifyTwoFactor), so signing in
  // again with a known password doesn't wipe the count of wrong codes.

  if (admin.totpEnabled) {
    return { stage: 'two_factor' as const, ...(await newSession(db, admin.id, 'two_factor', ctx)) };
  }
  // First sign-in (or 2FA was reset): create a new secret for the authenticator app.
  const secret = generateSecret();
  await db.adminUser.update({ where: { id: admin.id }, data: { totpSecret: encrypt(secret, key) } });
  return {
    stage: 'two_factor_setup' as const,
    ...(await newSession(db, admin.id, 'two_factor_setup', ctx)),
    setup: { secret, otpauthUrl: generateURI({ issuer: ISSUER, label: admin.email, secret }) },
  };
}

/**
 * Step 2: the 6-digit code from the authenticator app. On success the half-signed-in token is
 * replaced by a new full session token (so a token seen before 2FA is never a valid session).
 */
export async function verifyTwoFactor(
  db: Db,
  key: string | undefined,
  token: string,
  code: string,
  ctx: RequestContext,
) {
  const session = await db.adminSession.findUnique({ where: { tokenHash: sha256(token) }, include: { admin: true } });
  if (!session || session.stage === 'active' || session.expiresAt < new Date())
    throw new ApiError(401, 'SESSION_EXPIRED', 'Your sign-in has expired. Please sign in again.');
  const admin = session.admin;
  if (!admin.totpSecret || !admin.active) throw new ApiError(401, 'SESSION_EXPIRED', 'Please sign in again.');
  if (admin.lockedUntil && admin.lockedUntil > new Date())
    throw new ApiError(423, 'ACCOUNT_LOCKED', 'Too many wrong attempts. Try again in 15 minutes.');

  const claimed = await claimCode(db, key, admin, code, { totpEnabled: true, lastLoginAt: new Date() });
  if (!claimed) {
    // The session may already be gone (a parallel request used up its tries).
    const failedCodes =
      (
        await db.adminSession
          .update({ where: { id: session.id }, data: { failedCodes: { increment: 1 } }, select: { failedCodes: true } })
          .catch(() => null)
      )?.failedCodes ?? MAX_FAILED_CODES;
    if (failedCodes >= MAX_FAILED_CODES) await db.adminSession.deleteMany({ where: { id: session.id } });
    await countFailure(db, admin.id, 'auth.2fa_failed', ctx);
    throw new ApiError(
      401,
      failedCodes >= MAX_FAILED_CODES ? 'SESSION_EXPIRED' : 'INVALID_CODE',
      failedCodes >= MAX_FAILED_CODES
        ? 'Too many wrong codes. Please sign in again.'
        : 'That code is not right. Try the current one.',
    );
  }

  const enrolling = session.stage === 'two_factor_setup';
  await db.adminSession.delete({ where: { id: session.id } });
  const updated = await db.adminUser.findUniqueOrThrow({ where: { id: admin.id } });
  await audit(db, { adminId: admin.id, action: enrolling ? 'auth.2fa_enabled' : 'auth.login', ip: ctx.ip });
  return { ...(await newSession(db, admin.id, 'active', ctx)), admin: adminView(updated) };
}

/** The admin behind a full session token, or null. Touches lastSeenAt at most once a minute. */
export async function authenticate(db: Db, token: string) {
  const session = await db.adminSession.findUnique({ where: { tokenHash: sha256(token) }, include: { admin: true } });
  if (!session || session.stage !== 'active' || !session.admin.active) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() < now || session.lastSeenAt.getTime() + IDLE_TTL_MS < now) {
    await db.adminSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (now - session.lastSeenAt.getTime() > 60_000)
    await db.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
  return session.admin;
}

export async function logout(db: Db, token: string) {
  await db.adminSession.deleteMany({ where: { tokenHash: sha256(token) } });
}
