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
  })
  .refine((c) => c.NODE_ENV !== 'production' || c.ADMIN_ENCRYPTION_KEY, {
    message: 'ADMIN_ENCRYPTION_KEY is required in production',
    path: ['ADMIN_ENCRYPTION_KEY'],
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
