import { z } from 'zod';

// Environment variables are checked once at startup, so a missing or malformed value fails fast.
const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default('0.0.0.0'),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Storefront address, used in SMS links (e.g. the track-order page).
    STOREFRONT_URL: z.string().url().default('http://localhost:3000'),
    // "log" writes messages to the log instead of sending them; provider drivers are added later.
    SMS_DRIVER: z.enum(['log']).default('log'),
    // "inline" runs the outbox worker inside the API process; "off" leaves it to `npm run worker`.
    SMS_WORKER: z.enum(['inline', 'off']).default('inline'),
    // Per-IP request limits. Tests turn them off.
    RATE_LIMIT: z
      .enum(['on', 'off'])
      .default('on')
      .transform((v) => v === 'on'),
    // Comma-separated client IPs exempt from the per-IP request limits (e.g. a load-test machine).
    // Empty in normal use; the order fraud checks still apply.
    RATE_LIMIT_ALLOWLIST: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((ip) => ip.trim())
          .filter(Boolean),
      ),
    // Which proxies may set X-Forwarded-For (used for rate limits, fraud checks and the audit log).
    // "loopback" trusts only a proxy on the same machine (Caddy, the admin panel's server). Trusting
    // everyone would let any visitor fake their IP. Also accepts "true", "false" or comma-separated IPs/CIDRs.
    TRUST_PROXY: z
      .string()
      .default('loopback')
      .transform((v): boolean | string => (v === 'true' ? true : v === 'false' ? false : v)),
    // 32 random bytes, base64. Encrypts admin two-factor secrets. Generate with:
    //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    ADMIN_ENCRYPTION_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded')
        .optional(),
    ),
    // Image storage. "supabase" uploads to Supabase Storage; "memory" keeps files in memory (tests).
    STORAGE_DRIVER: z.enum(['supabase', 'memory']).default('supabase'),
    SUPABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    // A Supabase "secret" key (sb_secret_…) that can write to Storage. Never expose it to a browser.
    SUPABASE_SECRET_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    STORAGE_BUCKET: z.string().default('product-images'),
    // Shared with the storefront, which then refreshes its catalogue cache when products change.
    REVALIDATE_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
    // Pathao courier (Phase 6). Booking is switched off until the client, user and password are set.
    // The sandbox (default) accepts Pathao's published test account; live is https://api-hermes.pathao.com.
    COURIER_DRIVER: z.enum(['pathao', 'fake']).default('pathao'),
    PATHAO_BASE_URL: z.string().url().default('https://courier-api-sandbox.pathao.com'),
    PATHAO_CLIENT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    PATHAO_CLIENT_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    PATHAO_USERNAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    PATHAO_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    // Which Pathao store parcels are picked up from; the account's default store when empty.
    PATHAO_STORE_ID: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
    // The secret entered in Pathao's webhook settings. Pathao expects it echoed back in a header.
    PATHAO_WEBHOOK_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    // Check open parcels with Pathao this often (minutes); the webhook usually updates them sooner.
    COURIER_SYNC_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    // Sentry error tracking (sentry.io project → Client Keys). Off when empty.
    SENTRY_DSN: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
    // Shown in Sentry to tell staging from production, e.g. "staging".
    SENTRY_ENVIRONMENT: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(40).optional()),
  })
  .refine((c) => c.NODE_ENV !== 'production' || c.ADMIN_ENCRYPTION_KEY, {
    message: 'ADMIN_ENCRYPTION_KEY is required in production',
    path: ['ADMIN_ENCRYPTION_KEY'],
  })
  // Settings that are fine on a laptop but unsafe on a public server.
  .refine((c) => c.NODE_ENV !== 'production' || c.RATE_LIMIT, {
    message: 'RATE_LIMIT=off is not allowed in production',
    path: ['RATE_LIMIT'],
  })
  .refine((c) => c.NODE_ENV !== 'production' || c.TRUST_PROXY !== true, {
    message: 'TRUST_PROXY=true lets any visitor fake their IP; use "loopback" or the proxy addresses in production',
    path: ['TRUST_PROXY'],
  });

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    console.error('Invalid environment:', z.prettifyError(parsed.error));
    process.exit(1);
  }
  return parsed.data;
}
