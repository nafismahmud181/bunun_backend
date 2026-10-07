import type { Config } from '../../config.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import type { Db } from '../../lib/prisma.js';
import { type Booked, type CourierDriver, CourierError, type CourierStatus, type Parcel } from './driver.js';
import { pathaoDriver, pathaoLabel, pathaoStage, type TokenStore } from './pathao.js';

export * from './driver.js';

/** Tokens in the courier_tokens table, encrypted with ADMIN_ENCRYPTION_KEY. */
export function dbTokenStore(db: Db, courier: string, key: string): TokenStore {
  return {
    async load() {
      const row = await db.courierToken.findUnique({ where: { courier } });
      if (!row) return null;
      try {
        return {
          accessToken: decrypt(row.accessToken, key),
          refreshToken: row.refreshToken ? decrypt(row.refreshToken, key) : null,
          expiresAt: row.expiresAt.getTime(),
        };
      } catch {
        return null; // saved with another key: log in again
      }
    },
    async save(t) {
      const data = {
        accessToken: encrypt(t.accessToken, key),
        refreshToken: t.refreshToken ? encrypt(t.refreshToken, key) : null,
        expiresAt: new Date(t.expiresAt),
      };
      await db.courierToken.upsert({ where: { courier }, create: { courier, ...data }, update: data });
    },
  };
}

/**
 * The configured courier, or null when its credentials aren't set (booking is then switched off).
 * With a database and ADMIN_ENCRYPTION_KEY, its tokens are kept between restarts.
 */
export function createCourier(config: Config, db?: Db): CourierDriver | null {
  if (config.COURIER_DRIVER === 'fake') return fakeCourier();
  const { PATHAO_CLIENT_ID, PATHAO_CLIENT_SECRET, PATHAO_USERNAME, PATHAO_PASSWORD } = config;
  if (!PATHAO_CLIENT_ID || !PATHAO_CLIENT_SECRET || !PATHAO_USERNAME || !PATHAO_PASSWORD) return null;
  return pathaoDriver({
    baseUrl: config.PATHAO_BASE_URL,
    clientId: PATHAO_CLIENT_ID,
    clientSecret: PATHAO_CLIENT_SECRET,
    username: PATHAO_USERNAME,
    password: PATHAO_PASSWORD,
    storeId: config.PATHAO_STORE_ID,
    // One saved token per Pathao environment, so switching from the sandbox to live starts clean.
    ...(db &&
      config.ADMIN_ENCRYPTION_KEY && {
        tokens: dbTokenStore(db, `pathao ${new URL(config.PATHAO_BASE_URL).host}`, config.ADMIN_ENCRYPTION_KEY),
      }),
  });
}

/**
 * An in-memory courier for tests, behaving like Pathao's sandbox. `setStatus` moves a parcel on;
 * `failNext` makes the next booking fail ("rejected" or "unavailable").
 */
export function fakeCourier() {
  const parcels = new Map<string, Parcel & { status: string }>();
  let n = 0;
  let failNext: 'rejected' | 'unavailable' | null = null;
  const driver: CourierDriver & {
    parcels: typeof parcels;
    /** How many times the status was asked for. */
    statusCalls: number;
    setStatus(consignmentId: string, status: string): void;
    failNext(kind: 'rejected' | 'unavailable'): void;
  } = {
    name: 'pathao',
    label: 'Pathao',
    mode: 'sandbox',
    parcels,
    statusCalls: 0,
    async book(p: Parcel): Promise<Booked> {
      if (failNext === 'rejected') {
        failNext = null;
        throw new CourierError('rejected', 'Pathao: This recipient phone is not a valid phone number.', {
          recipient_phone: 'This recipient phone is not a valid phone number.',
        });
      }
      if (failNext === 'unavailable') {
        failNext = null;
        throw new CourierError('unavailable', 'Pathao did not answer (TimeoutError). Try again shortly.');
      }
      const consignmentId = `TEST${String(++n).padStart(6, '0')}`;
      parcels.set(consignmentId, { ...p, status: 'pending' });
      return { consignmentId, status: 'pending', statusLabel: pathaoLabel('pending'), deliveryFee: 60 };
    },
    async status(consignmentId: string): Promise<CourierStatus> {
      driver.statusCalls++;
      const p = parcels.get(consignmentId);
      const status = p?.status ?? 'pending';
      return { status, statusLabel: pathaoLabel(status) };
    },
    stage: pathaoStage,
    trackingUrl: (id, phone) => `https://merchant.pathao.com/tracking?consignment_id=${id}&phone=${phone}`,
    setStatus(consignmentId, status) {
      const p = parcels.get(consignmentId);
      if (p) p.status = status;
    },
    failNext(kind) {
      failNext = kind;
    },
  };
  return driver;
}
