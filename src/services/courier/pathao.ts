import type { Booked, CourierDriver, CourierStatus, Parcel, Stage } from './driver.js';
import { CourierError } from './driver.js';

// Pathao Merchant API (https://merchant.pathao.com → Developer's API). Checked against the
// sandbox on 2026-09-28: city/zone/area are optional on booking (Pathao reads them from the
// address), and it does NOT reject a repeated merchant_order_id, so callers must not book twice.

const LABELS: Record<string, string> = {
  pending: 'Booked, waiting for pickup',
  pickup_requested: 'Pickup requested',
  assigned_for_pickup: 'Rider on the way to pick up',
  picked: 'Picked up',
  pickup_failed: 'Pickup failed',
  pickup_cancelled: 'Pickup cancelled',
  at_the_sorting_hub: 'At the sorting hub',
  in_transit: 'In transit',
  received_at_last_mile_hub: 'At the delivery hub',
  assigned_for_delivery: 'Out for delivery',
  delivery_failed: 'Delivery attempt failed',
  on_hold: 'On hold',
  partial_delivery: 'Partly delivered',
  delivered: 'Delivered',
  payment_invoice: 'Delivered and paid',
  return: 'Returned',
  paid_return: 'Returned (charge paid)',
  exchange: 'Exchanged',
};

const PICKED_UP = new Set([
  'picked',
  'at_the_sorting_hub',
  'in_transit',
  'received_at_last_mile_hub',
  'assigned_for_delivery',
  'delivery_failed',
  'on_hold',
  'partial_delivery',
]);

const slugOf = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

export function pathaoStage(status: string): Stage {
  const s = slugOf(status);
  if (s === 'delivered' || s === 'payment_invoice') return 'delivered';
  if (s === 'return' || s === 'returned' || s === 'paid_return') return 'returned';
  if (s === 'pickup_cancelled' || s === 'cancelled') return 'cancelled';
  if (PICKED_UP.has(s)) return 'picked_up';
  return 'booked';
}

export const pathaoTrackingUrl = (consignmentId: string, phone: string) =>
  `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(consignmentId)}&phone=${encodeURIComponent(phone)}`;

export const pathaoLabel = (status: string, fallback?: string) => LABELS[slugOf(status)] ?? fallback ?? status;

/** An access token with the refresh token that renews it; expiresAt in epoch milliseconds. */
export interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

/** Where tokens are kept between restarts (Pathao asks merchants to persist them). */
export interface TokenStore {
  load(): Promise<StoredToken | null>;
  save(token: StoredToken): Promise<void>;
}

interface Credentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  storeId?: number;
  tokens?: TokenStore;
}

const ISSUE = '/aladdin/api/v1/issue-token';

type Json = Record<string, unknown>;

export function pathaoDriver(c: Credentials, fetchImpl: typeof fetch = fetch): CourierDriver {
  const base = c.baseUrl.replace(/\/$/, '');
  let token: StoredToken | null = null;
  let loaded = false;
  let renewing: Promise<string> | null = null;
  const fresh = (t: StoredToken | null): t is StoredToken => !!t && t.expiresAt > Date.now() + 60_000;
  let storeId = c.storeId ?? null;

  async function call(method: string, path: string, body?: Json, retried = false): Promise<Json> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(path !== ISSUE && { authorization: `Bearer ${await accessToken()}` }),
        },
        ...(body && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new CourierError('unavailable', `Pathao did not answer (${(err as Error).name}). Try again shortly.`);
    }
    const json = (await res.json().catch(() => ({}))) as Json;
    if (res.status === 401 && !retried && path !== ISSUE) {
      if (token) token = { ...token, expiresAt: 0 }; // expired or revoked: renew once (keeps the refresh token)
      return call(method, path, body, true);
    }
    if (res.status >= 500)
      throw new CourierError('unavailable', `Pathao had a problem (HTTP ${res.status}). Try again shortly.`);
    if (!res.ok || json.type === 'error') {
      const errors = (json.errors ?? {}) as Record<string, string[] | string>;
      const fields = Object.fromEntries(
        Object.entries(errors).map(([k, v]) => [k, Array.isArray(v) ? v.join(' ') : String(v)]),
      );
      const detail = Object.values(fields)[0];
      throw new CourierError(
        'rejected',
        detail
          ? `Pathao: ${detail.replace(/\s+/g, ' ')}`
          : `Pathao refused the request (${String(json.message ?? res.status)}).`,
        fields,
      );
    }
    return json;
  }

  /**
   * A valid access token: the one in memory, else the saved one, else renewed with the refresh
   * token, and only if that fails, a new login with the username and password. Concurrent callers
   * share one renewal.
   */
  async function accessToken(): Promise<string> {
    if (fresh(token)) return token.accessToken;
    if (!loaded && c.tokens) {
      loaded = true;
      const saved = await c.tokens.load().catch(() => null);
      if (saved) token = saved;
      if (fresh(token)) return token.accessToken;
    }
    renewing ??= renew().finally(() => {
      renewing = null;
    });
    return renewing;
  }

  async function renew() {
    const client = { client_id: c.clientId, client_secret: c.clientSecret };
    let json: Json | null = null;
    if (token?.refreshToken) {
      json = await call('POST', ISSUE, {
        ...client,
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      }).catch((err: unknown) => {
        if (err instanceof CourierError && err.kind === 'rejected') return null; // refresh token no longer valid
        throw err;
      });
    }
    json ??= await call('POST', ISSUE, {
      ...client,
      grant_type: 'password',
      username: c.username,
      password: c.password,
    });
    const accessToken = String(json.access_token ?? '');
    if (!accessToken)
      throw new CourierError('unavailable', 'Pathao did not return an access token. Check the credentials.');
    token = {
      accessToken,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : (token?.refreshToken ?? null),
      expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    };
    await c.tokens?.save(token).catch(() => {}); // a failed save only costs a login next time
    return accessToken;
  }

  async function pickupStore() {
    if (storeId) return storeId;
    const json = await call('GET', '/aladdin/api/v1/stores');
    const stores = ((json.data as Json)?.data ?? []) as {
      store_id: number;
      is_default_store?: boolean;
      is_active?: number;
    }[];
    const store = stores.find((s) => s.is_default_store && s.is_active !== 0) ?? stores.find((s) => s.is_active !== 0);
    if (!store) throw new CourierError('rejected', 'The Pathao account has no active store to pick up from.');
    storeId = store.store_id;
    return storeId;
  }

  const mode = /sandbox/.test(base) ? 'sandbox' : 'live';
  return {
    // Sandbox parcels are kept apart ("pathao-sandbox"): they aren't on Pathao's public tracking
    // page, and a live account can't look them up.
    name: mode === 'sandbox' ? 'pathao-sandbox' : 'pathao',
    label: 'Pathao',
    mode,
    async book(p: Parcel): Promise<Booked> {
      const json = await call('POST', '/aladdin/api/v1/orders', {
        store_id: await pickupStore(),
        merchant_order_id: p.merchantOrderId,
        recipient_name: p.name.slice(0, 64),
        recipient_phone: p.phone,
        recipient_address: p.address.slice(0, 220),
        delivery_type: 48, // normal delivery
        item_type: 2, // parcel
        item_quantity: Math.max(1, p.itemQuantity),
        item_weight: Math.min(10, Math.max(0.5, Math.round(p.weightKg * 10) / 10)),
        item_description: p.description.slice(0, 250),
        amount_to_collect: Math.round(p.codAmount),
        ...(p.instruction && { special_instruction: p.instruction.slice(0, 250) }),
      });
      const d = (json.data ?? {}) as Json;
      const status = String(d.order_status ?? 'Pending');
      return {
        consignmentId: String(d.consignment_id),
        status: slugOf(status),
        statusLabel: pathaoLabel(status),
        deliveryFee: typeof d.delivery_fee === 'number' ? d.delivery_fee : null,
      };
    },
    async status(consignmentId: string): Promise<CourierStatus> {
      const json = await call('GET', `/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`);
      const d = (json.data ?? {}) as Json;
      const raw = String(d.order_status_slug ?? d.order_status ?? 'pending');
      return { status: slugOf(raw), statusLabel: pathaoLabel(raw, String(d.order_status ?? raw)) };
    },
    stage: pathaoStage,
    trackingUrl: pathaoTrackingUrl,
  };
}
