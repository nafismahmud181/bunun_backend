// Danger zone against a real database. Only the sessions-only reset runs here: a full reset would
// wipe the orders and customers of the local development database the tests share.
// TEST_DATABASE_URL=... npm run test:integration
import { randomBytes } from 'node:crypto';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { decrypt, randomToken, sha256 } from '../../src/lib/crypto.js';
import { createPrisma } from '../../src/lib/prisma.js';
import { memoryStore } from '../../src/services/storage.js';
import { TEST_KEY, signedInAdmin } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createPrisma(url) : null;
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const tag = randomBytes(3).toString('hex');
const ownerEmail = `owner-${tag}@test.bunon`;
let owner: string;
let ownerElsewhere: string;
let manager: string;

const nothing = { orders: false, customers: false, coupons: false, auditLog: false, sessions: false };
async function reset(token: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/data-reset',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() };
}
/** A code for the owner's next TOTP time step (the current one was used up at sign-in). */
async function nextCode(stepsAhead = 1) {
  const a = await db!.adminUser.findUniqueOrThrow({ where: { email: ownerEmail } });
  const secret = decrypt(a.totpSecret!, TEST_KEY);
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 * stepsAhead });
}

describe.skipIf(!url)('danger zone (database)', () => {
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url!,
      LOG_LEVEL: 'silent',
      RATE_LIMIT: 'off',
      ADMIN_ENCRYPTION_KEY: TEST_KEY,
    });
    app = await buildApp(config, db!, memoryStore());
    owner = await signedInAdmin(app, db!, ownerEmail, 'owner');
    manager = await signedInAdmin(app, db!, `manager-${tag}@test.bunon`, 'manager');
    // A second session of the same owner, as if signed in on another computer.
    const a = await db!.adminUser.findUniqueOrThrow({ where: { email: ownerEmail } });
    ownerElsewhere = randomToken();
    await db!.adminSession.create({
      data: {
        tokenHash: sha256(ownerElsewhere),
        adminId: a.id,
        stage: 'active',
        expiresAt: new Date(Date.now() + 3600_000),
        ip: '127.0.0.1',
      },
    });
  });

  afterAll(async () => {
    const admins = await db!.adminUser.findMany({ where: { email: { contains: tag } }, select: { id: true } });
    await db!.auditLog.deleteMany({ where: { adminId: { in: admins.map((a) => a.id) } } });
    await db!.adminUser.deleteMany({ where: { id: { in: admins.map((a) => a.id) } } });
    await app.close();
  });

  it('is for the owner only', async () => {
    const r = await reset(manager, { ...nothing, sessions: true, code: '123456', confirm: 'RESET' });
    expect(r.status).toBe(403);
  });

  it('needs RESET typed, something chosen and a 6-digit code', async () => {
    expect((await reset(owner, { ...nothing, sessions: true, code: '123456', confirm: 'reset' })).status).toBe(400);
    expect((await reset(owner, { ...nothing, code: '123456', confirm: 'RESET' })).status).toBe(400);
    expect((await reset(owner, { ...nothing, sessions: true, code: '12', confirm: 'RESET' })).status).toBe(400);
  });

  it('refuses a wrong code and counts it towards the lock', async () => {
    const r = await reset(owner, { ...nothing, sessions: true, code: '000000', confirm: 'RESET' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_CODE');
    const a = await db!.adminUser.findUniqueOrThrow({ where: { email: ownerEmail } });
    expect(a.failedLogins).toBe(1);
    expect(await db!.adminSession.count({ where: { adminId: a.id } })).toBe(2);
  });

  it('signs out other sessions, keeps the caller, records it, and refuses the same code twice', async () => {
    const code = await nextCode();
    const r = await reset(owner, { ...nothing, sessions: true, code, confirm: 'RESET' });
    expect(r.status).toBe(200);
    expect(r.body.deleted.sessions).toBeGreaterThanOrEqual(2); // the owner's other one and the manager's
    expect(r.body.deleted.orders).toBe(0);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/auth/me',
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(me.statusCode).toBe(200);
    for (const gone of [ownerElsewhere, manager]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/auth/me',
        headers: { authorization: `Bearer ${gone}` },
      });
      expect(res.statusCode).toBe(401);
    }

    const a = await db!.adminUser.findUniqueOrThrow({ where: { email: ownerEmail } });
    expect(a.failedLogins).toBe(0);
    const entry = await db!.auditLog.findFirstOrThrow({ where: { adminId: a.id, action: 'data.reset' } });
    expect(entry.data).toMatchObject({ parts: { sessions: true, orders: false } });

    const again = await reset(owner, { ...nothing, sessions: true, code, confirm: 'RESET' });
    expect(again.status).toBe(400);
  });
});
