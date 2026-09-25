import { z } from 'zod';

// Environment variables are checked once at startup, so a missing or malformed value fails fast.
const Env = z.object({
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
