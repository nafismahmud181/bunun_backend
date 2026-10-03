import { describe, expect, it } from 'vitest';
import { deliveryRisk } from '../src/lib/delivery-risk.js';
import { CourierError } from '../src/services/courier/driver.js';
import {
  type StoredToken,
  type TokenStore,
  pathaoDriver,
  pathaoLabel,
  pathaoStage,
} from '../src/services/courier/pathao.js';

type Call = { method: string; path: string; body?: Record<string, unknown>; auth?: string };

/** A stand-in for Pathao's API that records every call. `routes` answer by "METHOD path". */
function fakePathao(routes: Record<string, (call: Call) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const call: Call = {
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string>)?.authorization,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${path}`];
    if (!handler) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const { status = 200, json } = handler(call);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const creds = {
  baseUrl: 'https://courier-api-sandbox.pathao.com',
  clientId: 'id',
  clientSecret: 'secret',
  username: 'u@example.com',
  password: 'pw',
};
const token = { json: { token_type: 'Bearer', expires_in: 7776000, access_token: 'tok-1', refresh_token: 'r' } };
const stores = {
  json: {
    data: {
      data: [
        { store_id: 7, is_active: 1, is_default_store: false },
        { store_id: 9, is_active: 1, is_default_store: true },
      ],
    },
  },
};
const parcel = {
  merchantOrderId: 'BN-2026-000123',
  name: 'Rahima Begum',
  phone: '01712345678',
  address: 'House 12, Road 5, Dhanmondi, Dhaka',
  codAmount: 1850,
  weightKg: 0.34,
  itemQuantity: 2,
  description: '2 × Nakshi Kantha Table Runner (Small)',
};

describe('Pathao driver', () => {
  it('books with a cached token and the default pickup store', async () => {
    const { calls, fetchImpl } = fakePathao({
      'POST /aladdin/api/v1/issue-token': () => token,
      'GET /aladdin/api/v1/stores': () => stores,
      'POST /aladdin/api/v1/orders': () => ({
        json: { type: 'success', data: { consignment_id: 'DT1', order_status: 'Pending', delivery_fee: 60 } },
      }),
    });
    const pathao = pathaoDriver(creds, fetchImpl);
    const booked = await pathao.book(parcel);
    await pathao.book({ ...parcel, merchantOrderId: 'BN-2026-000124' });
    expect(booked).toEqual({
      consignmentId: 'DT1',
      status: 'pending',
      statusLabel: 'Booked, waiting for pickup',
      deliveryFee: 60,
    });
    expect(calls.filter((c) => c.path.endsWith('issue-token'))).toHaveLength(1); // token reused
    const order = calls.find((c) => c.path.endsWith('/orders'))!;
    expect(order.auth).toBe('Bearer tok-1');
    expect(order.body).toMatchObject({
      store_id: 9, // the default store
      merchant_order_id: 'BN-2026-000123',
      recipient_phone: '01712345678',
      delivery_type: 48,
      item_type: 2,
      item_weight: 0.5, // Pathao's minimum
      amount_to_collect: 1850,
    });
    expect(order.body).not.toHaveProperty('recipient_city'); // Pathao reads the area from the address
  });

  it('gets a new token once when Pathao says the old one expired', async () => {
    let n = 0;
    const { calls, fetchImpl } = fakePathao({
      'POST /aladdin/api/v1/issue-token': () => ({ json: { ...token.json, access_token: `tok-${++n}` } }),
      'GET /aladdin/api/v1/orders/DT1/info': (c) =>
        c.auth === 'Bearer tok-1'
          ? { status: 401, json: { message: 'Unauthenticated.' } }
          : { json: { data: { order_status: 'In Transit', order_status_slug: 'In_Transit' } } },
    });
    const status = await pathaoDriver({ ...creds, storeId: 5 }, fetchImpl).status('DT1');
    expect(status).toEqual({ status: 'in_transit', statusLabel: 'In transit' });
    expect(calls.filter((c) => c.path.endsWith('issue-token'))).toHaveLength(2);
  });

  it('reports field errors as "rejected" and outages as "unavailable"', async () => {
    const rejected = fakePathao({
      'POST /aladdin/api/v1/issue-token': () => token,
      'POST /aladdin/api/v1/orders': () => ({
        status: 422,
        json: {
          message: 'Please fix the given errors',
          type: 'error',
          errors: { recipient_phone: ['This recipient phone is not a valid phone number.'] },
        },
      }),
    });
    const err = await pathaoDriver({ ...creds, storeId: 5 }, rejected.fetchImpl)
      .book(parcel)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CourierError);
    expect(err).toMatchObject({
      kind: 'rejected',
      message: 'Pathao: This recipient phone is not a valid phone number.',
      fields: { recipient_phone: 'This recipient phone is not a valid phone number.' },
    });

    const down = fakePathao({
      'POST /aladdin/api/v1/issue-token': () => token,
      'POST /aladdin/api/v1/orders': () => ({ status: 503, json: {} }),
    });
    await expect(pathaoDriver({ ...creds, storeId: 5 }, down.fetchImpl).book(parcel)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(pathaoDriver(creds, offline).status('DT1')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('keeps tokens between restarts and renews them with the refresh token', async () => {
    let saved: StoredToken | null = null;
    const tokens: TokenStore = {
      load: async () => saved,
      save: async (t) => {
        saved = t;
      },
    };
    const grants: string[] = [];
    const { fetchImpl } = fakePathao({
      'POST /aladdin/api/v1/issue-token': (c) => {
        grants.push(String(c.body!.grant_type));
        return {
          json: { expires_in: 432000, access_token: `tok-${grants.length}`, refresh_token: `ref-${grants.length}` },
        };
      },
      'GET /aladdin/api/v1/orders/DT1/info': () => ({ json: { data: { order_status_slug: 'Pending' } } }),
    });
    // First start: logs in with the password and saves the token.
    await pathaoDriver({ ...creds, tokens }, fetchImpl).status('DT1');
    expect(grants).toEqual(['password']);
    expect(saved).toMatchObject({ accessToken: 'tok-1', refreshToken: 'ref-1' });
    // A restart reuses the saved token: no login at all.
    await pathaoDriver({ ...creds, tokens }, fetchImpl).status('DT1');
    expect(grants).toEqual(['password']);
    // Once it has expired, the refresh token renews it (the password isn't sent again).
    saved = { ...saved!, expiresAt: Date.now() - 1 };
    await pathaoDriver({ ...creds, tokens }, fetchImpl).status('DT1');
    expect(grants).toEqual(['password', 'refresh_token']);
    expect(saved).toMatchObject({ accessToken: 'tok-2', refreshToken: 'ref-2' });
  });

  it('logs in with the password only when the refresh token is refused', async () => {
    const grants: string[] = [];
    const { fetchImpl } = fakePathao({
      'POST /aladdin/api/v1/issue-token': (c) => {
        grants.push(String(c.body!.grant_type));
        return c.body!.grant_type === 'refresh_token'
          ? { status: 401, json: { message: 'The refresh token is invalid.' } }
          : { json: { expires_in: 432000, access_token: 'tok-new', refresh_token: 'ref-new' } };
      },
      'GET /aladdin/api/v1/orders/DT1/info': () => ({ json: { data: { order_status_slug: 'Pending' } } }),
    });
    const tokens: TokenStore = {
      load: async () => ({ accessToken: 'old', refreshToken: 'ref-old', expiresAt: 0 }),
      save: async () => {},
    };
    await pathaoDriver({ ...creds, tokens }, fetchImpl).status('DT1');
    expect(grants).toEqual(['refresh_token', 'password']);
  });

  it('knows sandbox from live and builds the tracking link', () => {
    expect(pathaoDriver(creds).mode).toBe('sandbox');
    expect(pathaoDriver(creds).name).toBe('pathao-sandbox'); // kept apart from live parcels
    const live = pathaoDriver({ ...creds, baseUrl: 'https://api-hermes.pathao.com' });
    expect(live.mode).toBe('live');
    expect(live.name).toBe('pathao');
    expect(live.trackingUrl('DT1', '01712345678')).toBe(
      'https://merchant.pathao.com/tracking?consignment_id=DT1&phone=01712345678',
    );
  });
});

describe('courier status rules', () => {
  it('maps Pathao statuses to what they mean for the order', () => {
    expect(['Pending', 'Pickup_Requested', 'Assigned_for_Pickup', 'Pickup_Failed'].map(pathaoStage)).toEqual([
      'booked',
      'booked',
      'booked',
      'booked',
    ]);
    expect(['Picked', 'In_Transit', 'Assigned_for_Delivery', 'Delivery_Failed'].map(pathaoStage)).toEqual([
      'picked_up',
      'picked_up',
      'picked_up',
      'picked_up',
    ]);
    expect(pathaoStage('Delivered')).toBe('delivered');
    expect(pathaoStage('Payment_Invoice')).toBe('delivered');
    expect(pathaoStage('Return')).toBe('returned');
    expect(pathaoStage('Pickup_Cancelled')).toBe('cancelled');
    expect(pathaoLabel('Assigned_for_Delivery')).toBe('Out for delivery');
    expect(pathaoLabel('something_new', 'Something New')).toBe('Something New');
  });

  it('rates a phone number from its delivered and returned orders', () => {
    expect(deliveryRisk({ delivered: 0, returned: 0 })).toEqual({ level: 'new', successRate: null });
    expect(deliveryRisk({ delivered: 9, returned: 1 })).toEqual({ level: 'good', successRate: 90 });
    expect(deliveryRisk({ delivered: 3, returned: 1 })).toEqual({ level: 'watch', successRate: 75 });
    expect(deliveryRisk({ delivered: 0, returned: 1 })).toEqual({ level: 'high', successRate: 0 });
    expect(deliveryRisk({ delivered: 1, returned: 2 })).toEqual({ level: 'high', successRate: 33 });
  });
});
