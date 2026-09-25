import { verify as verifyPassword } from '@node-rs/argon2';
import type { z } from 'zod';
import type { AdminUser } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { generatePassword } from '../lib/password.js';
import type { Db } from '../lib/prisma.js';
import type { StaffCreate, StaffUpdate } from '../schemas/admin-3c.js';
import { hashPassword } from './admin-auth.js';

interface Context {
  admin: AdminUser;
  ip: string;
}

async function member(db: Db, id: number) {
  const a = await db.adminUser.findUnique({
    where: { id },
    include: { _count: { select: { sessions: { where: { stage: 'active', expiresAt: { gt: new Date() } } } } } },
  });
  if (!a) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    role: a.role,
    active: a.active,
    twoFactorSetUp: a.totpEnabled,
    lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
    activeSessions: a._count.sessions,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function listStaff(db: Db) {
  const all = await db.adminUser.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }], select: { id: true } });
  return Promise.all(all.map((a) => member(db, a.id)));
}

/** A new account with a one-time password; two-factor authentication is set up at first sign-in. */
export async function inviteStaff(db: Db, input: z.infer<typeof StaffCreate>, ctx: Context) {
  if (await db.adminUser.findUnique({ where: { email: input.email } }))
    throw new ApiError(409, 'EMAIL_TAKEN', 'There is already an account with that email.');
  const password = generatePassword();
  const a = await db.adminUser.create({ data: { ...input, passwordHash: await hashPassword(password) } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'staff.invite',
    entityType: 'admin',
    entityId: a.id,
    ip: ctx.ip,
    data: { email: a.email, role: a.role },
  });
  return { member: await member(db, a.id), password };
}

/** The shop must always keep at least one active owner. */
async function assertOwnerRemains(db: Db, target: AdminUser, next: { role?: string; active?: boolean }) {
  const losesOwner =
    target.role === 'owner' && target.active && ((next.role && next.role !== 'owner') || next.active === false);
  if (!losesOwner) return;
  const owners = await db.adminUser.count({ where: { role: 'owner', active: true } });
  if (owners <= 1)
    throw new ApiError(409, 'LAST_OWNER', 'Keep at least one active owner: make someone else an owner first.');
}

export async function updateStaff(db: Db, id: number, input: z.infer<typeof StaffUpdate>, ctx: Context) {
  const target = await db.adminUser.findUnique({ where: { id } });
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
  if (id === ctx.admin.id && (input.active === false || (input.role && input.role !== target.role)))
    throw new ApiError(409, 'SELF_CHANGE', "You can't disable yourself or change your own role.");
  await assertOwnerRemains(db, target, input);
  await db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id }, data: input });
    // Disabling or changing someone's role signs them out, so the change applies at once.
    if (input.active === false || (input.role && input.role !== target.role))
      await tx.adminSession.deleteMany({ where: { adminId: id } });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'staff.update',
      entityType: 'admin',
      entityId: id,
      ip: ctx.ip,
      data: {
        email: target.email,
        before: { role: target.role, active: target.active, name: target.name },
        after: input,
      },
    });
  });
  return member(db, id);
}

/** New one-time password, two-factor set up again at next sign-in, all sessions ended. */
export async function resetStaff(db: Db, id: number, ctx: Context) {
  const target = await db.adminUser.findUnique({ where: { id } });
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
  if (id === ctx.admin.id) throw new ApiError(409, 'SELF_CHANGE', 'Use "Change password" for your own account.');
  const password = generatePassword();
  await db.$transaction(async (tx) => {
    await tx.adminUser.update({
      where: { id },
      data: {
        passwordHash: await hashPassword(password),
        totpSecret: null,
        totpEnabled: false,
        totpLastStep: null,
        failedLogins: 0,
        lockedUntil: null,
      },
    });
    await tx.adminSession.deleteMany({ where: { adminId: id } });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'staff.reset',
      entityType: 'admin',
      entityId: id,
      ip: ctx.ip,
      data: { email: target.email },
    });
  });
  return { member: await member(db, id), password };
}

export async function signOutStaff(db: Db, id: number, ctx: Context) {
  const target = await db.adminUser.findUnique({ where: { id } });
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found.');
  const { count } = await db.adminSession.deleteMany({ where: { adminId: id } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'staff.sign_out',
    entityType: 'admin',
    entityId: id,
    ip: ctx.ip,
    data: { sessions: count },
  });
  return member(db, id);
}

/** Changes the signed-in admin's password; other sessions are signed out, this one stays. */
export async function changeOwnPassword(db: Db, current: string, next: string, sessionToken: string, ctx: Context) {
  const me = await db.adminUser.findUniqueOrThrow({ where: { id: ctx.admin.id } });
  if (!(await verifyPassword(me.passwordHash, current)))
    throw new ApiError(400, 'WRONG_PASSWORD', 'Your current password is not right.');
  if (current === next) throw new ApiError(400, 'SAME_PASSWORD', 'Choose a password different from the current one.');
  await db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: me.id }, data: { passwordHash: await hashPassword(next) } });
    await tx.adminSession.deleteMany({ where: { adminId: me.id, tokenHash: { not: sha256(sessionToken) } } });
    await audit(tx, {
      adminId: me.id,
      action: 'auth.password_changed',
      entityType: 'admin',
      entityId: me.id,
      ip: ctx.ip,
    });
  });
}
