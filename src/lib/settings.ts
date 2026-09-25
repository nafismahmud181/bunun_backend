import type { Db } from './prisma.js';

// Defaults used when a setting row is missing; the seed writes these as the starting values.
export const SETTING_DEFAULTS = {
  free_delivery_threshold: 3000,
  hotline: '09612-345678',
  order_limit_per_phone_24h: 5,
  order_limit_per_ip_1h: 10,
  // Variants at or below this many units show in the admin's low-stock list.
  low_stock_threshold: 5,
  // Business details printed on invoices and packing slips. REVIEW before launch.
  store_name: 'Bunon',
  store_address: 'House 12, Road 5, Dhanmondi, Dhaka 1205',
  store_email: 'support@bunon.com.bd',
  trade_licence: 'TRAD/DNCC/000000/2026',
};

const DEFAULTS = SETTING_DEFAULTS;
export type Settings = typeof DEFAULTS;

/** All store settings, with defaults for any that aren't in the database. */
export async function getSettings(db: Pick<Db, 'setting'>): Promise<Settings> {
  const rows = await db.setting.findMany({ where: { key: { in: Object.keys(DEFAULTS) } } });
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) {
    const fallback = DEFAULTS[r.key as keyof Settings];
    // Ignore a stored value of the wrong type rather than breaking checkout.
    if (typeof r.value === typeof fallback) out[r.key] = r.value;
  }
  return out as Settings;
}
