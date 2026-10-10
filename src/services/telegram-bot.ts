import type { AdminUser } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import { checkCredentials, type RequestContext } from './admin-auth.js';

// The Telegram deploy bot (bunun_deploybot) signs in an owner once with email, password and a
// two-factor code, then asks before every command whether that Telegram account may still act.

/** Changes when the password or the two-factor setup changes, which signs Telegram out. */
const fingerprint = (a: AdminUser) => sha256(`${a.passwordHash}|${a.totpSecret ?? ''}`);
const view = (a: AdminUser) => ({ name: a.name, email: a.email });

export async function linkTelegram(
  db: Db,
  key: string | undefined,
  input: { telegramUserId: number; email: string; password: string; code: string },
  ctx: RequestContext,
) {
  const admin = await checkCredentials(db, key, input, ctx);
  if (admin.role !== 'owner') throw new ApiError(403, 'NOT_OWNER', 'Only the store owner can use the deploy bot.');
  const telegramUserId = BigInt(input.telegramUserId);
  await db.telegramLink.upsert({
    where: { telegramUserId },
    create: { telegramUserId, adminId: admin.id, fingerprint: fingerprint(admin) },
    update: { adminId: admin.id, fingerprint: fingerprint(admin), createdAt: new Date(), lastUsedAt: new Date() },
  });
  await audit(db, {
    adminId: admin.id,
    action: 'telegram.linked',
    entityType: 'telegram',
    entityId: input.telegramUserId,
    ip: ctx.ip,
  });
  return view(admin);
}

/**
 * The owner signed in on this Telegram account, or null. A link stops working (and is removed)
 * when the account is disabled, is no longer the owner, or its password or two-factor changed.
 */
export async function telegramSession(db: Db, telegramUserId: number) {
  const link = await db.telegramLink.findUnique({
    where: { telegramUserId: BigInt(telegramUserId) },
    include: { admin: true },
  });
  if (!link) return null;
  const a = link.admin;
  if (!a.active || a.role !== 'owner' || link.fingerprint !== fingerprint(a)) {
    await db.telegramLink.deleteMany({ where: { telegramUserId: link.telegramUserId } });
    return null;
  }
  if (Date.now() - link.lastUsedAt.getTime() > 60_000)
    await db.telegramLink.update({ where: { telegramUserId: link.telegramUserId }, data: { lastUsedAt: new Date() } });
  return { admin: a, ...view(a) };
}

export async function unlinkTelegram(db: Db, telegramUserId: number, ip: string) {
  const link = await db.telegramLink.findUnique({ where: { telegramUserId: BigInt(telegramUserId) } });
  if (!link) return;
  await db.telegramLink.delete({ where: { telegramUserId: link.telegramUserId } });
  await audit(db, {
    adminId: link.adminId,
    action: 'telegram.unlinked',
    entityType: 'telegram',
    entityId: telegramUserId,
    ip,
  });
}

/** Records a deploy or restart started from Telegram in the admin audit log. */
export async function auditTelegram(
  db: Db,
  telegramUserId: number,
  input: { action: 'deploy' | 'restart'; app: string; result: string },
  ip: string,
) {
  const session = await telegramSession(db, telegramUserId);
  if (!session) throw new ApiError(401, 'NOT_LINKED', 'Sign in to the bot again.');
  await audit(db, {
    adminId: session.admin.id,
    action: `telegram.${input.action}`,
    entityType: 'app',
    entityId: input.app,
    data: { result: input.result, telegramUserId },
    ip,
  });
}
