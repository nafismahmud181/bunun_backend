// Telegram deploy bot sign-in against a real database. TEST_DATABASE_URL=... npm run test:integration
import { randomBytes } from 'node:crypto';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { decrypt } from '../../src/lib/crypto.js';
import { createPrisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/services/admin-auth.js';
import { memoryStore } from '../../src/services/storage.js';
import { TEST_KEY, signedInAdmin } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createPrisma(url) : null;
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const SECRET = randomBytes(24).toString('hex');
const tag = randomBytes(3).toString('hex');
const ownerEmail = `owner-${tag}@test.bunon`;
const managerEmail = `manager-${tag}@test.bunon`;
const tgOwner = 7_000_000_000 + Math.floor(Math.random() * 1e6);
const tgOther = tgOwner + 1;

const config = (extra: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url!,
    LOG_LEVEL: 'silent',
    RATE_LIMIT: 'off',
    ADMIN_ENCRYPTION_KEY: TEST_KEY,
    ...extra,
  });
async function bot(path: string, body: unknown, secret: string | null = SECRET, on: App = app) {
  const res = await on.inject({
    method: 'POST',
    url: `/api/v1/bot/${path}`,
    headers: secret === null ? {} : { 'x-bot-secret': secret },
    payload: body as object,
  });
  return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
}
/** A fresh code for an admin (clears the used step so each test can sign in again). */
async function code(email: string) {
  const a = await db!.adminUser.update({ where: { email }, data: { totpLastStep: null } });
  return generate({ secret: decrypt(a.totpSecret!, TEST_KEY) });
}
const link = async (email: string, telegramUserId: number, password = 'test-password') =>
  bot('link', { telegramUserId, email, password, code: await code(email) });

describe.skipIf(!url)('Telegram deploy bot (database)', () => {
  beforeAll(async () => {
    app = await buildApp(config({ BOT_API_SECRET: SECRET }), db!, memoryStore());
    await signedInAdmin(app, db!, ownerEmail, 'owner');
    await signedInAdmin(app, db!, managerEmail, 'manager');
  });

  afterAll(async () => {
    const admins = await db!.adminUser.findMany({ where: { email: { contains: tag } }, select: { id: true } });
    await db!.auditLog.deleteMany({ where: { adminId: { in: admins.map((a) => a.id) } } });
    await db!.adminUser.deleteMany({ where: { id: { in: admins.map((a) => a.id) } } });
    await app.close();
  });

  it('needs the shared secret, and is off without one', async () => {
    expect((await bot('session', { telegramUserId: tgOwner }, null)).status).toBe(401);
    expect((await bot('session', { telegramUserId: tgOwner }, 'wrong')).status).toBe(401);
    const off = await buildApp(config(), db!, memoryStore());
    expect((await bot('session', { telegramUserId: tgOwner }, SECRET, off)).status).toBe(404);
    await off.close();
  });

  it('refuses a wrong password, a wrong code and a non-owner', async () => {
    expect((await link(ownerEmail, tgOwner, 'not-the-password')).body.code).toBe('INVALID_LOGIN');
    await code(ownerEmail);
    const wrongCode = await bot('link', {
      telegramUserId: tgOwner,
      email: ownerEmail,
      password: 'test-password',
      code: '000000',
    });
    expect(wrongCode.body.code).toBe('INVALID_CODE');
    const a = await db!.adminUser.findUniqueOrThrow({ where: { email: ownerEmail } });
    expect(a.failedLogins).toBe(2); // both count towards the 15-minute lock
    expect((await link(managerEmail, tgOther)).body.code).toBe('NOT_OWNER');
    expect((await bot('session', { telegramUserId: tgOther })).body.owner).toBeNull();
  });

  it('signs the owner in, records deploys, and signs out on /logout', async () => {
    const r = await link(ownerEmail, tgOwner);
    expect(r.status).toBe(200);
    expect(r.body.email).toBe(ownerEmail);
    expect((await bot('session', { telegramUserId: tgOwner })).body.owner.email).toBe(ownerEmail);

    const audited = await bot('audit', {
      telegramUserId: tgOwner,
      action: 'deploy',
      app: 'backend',
      result: 'finished',
    });
    expect(audited.status).toBe(204);
    const a = await db!.adminUser.findUniqueOrThrow({ where: { email: ownerEmail } });
    const entry = await db!.auditLog.findFirstOrThrow({ where: { adminId: a.id, action: 'telegram.deploy' } });
    expect(entry.entityId).toBe('backend');

    expect((await bot('unlink', { telegramUserId: tgOwner })).status).toBe(204);
    expect((await bot('session', { telegramUserId: tgOwner })).body.owner).toBeNull();
    expect((await bot('audit', { telegramUserId: tgOwner, action: 'deploy', app: 'x', result: 'y' })).status).toBe(401);
  });

  it('signs Telegram out when the password changes or the account is demoted', async () => {
    await link(ownerEmail, tgOwner);
    await db!.adminUser.update({
      where: { email: ownerEmail },
      data: { passwordHash: await hashPassword('new-pass') },
    });
    expect((await bot('session', { telegramUserId: tgOwner })).body.owner).toBeNull();
    expect(await db!.telegramLink.count({ where: { telegramUserId: BigInt(tgOwner) } })).toBe(0);

    await db!.adminUser.update({
      where: { email: ownerEmail },
      data: { passwordHash: await hashPassword('test-password') },
    });
    await link(ownerEmail, tgOwner);
    await db!.adminUser.update({ where: { email: ownerEmail }, data: { role: 'manager' } });
    expect((await bot('session', { telegramUserId: tgOwner })).body.owner).toBeNull();
  });
});
