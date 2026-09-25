import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tells the storefront its catalogue cache is out of date (POST /api/revalidate), so an admin
 * change shows up straight away instead of within 60 seconds. Several changes in quick
 * succession send one call. Failures are logged, never thrown: the cache expires on its own.
 */
export function notifyStorefront(config: Config, log: FastifyBaseLogger) {
  if (!config.REVALIDATE_SECRET || config.NODE_ENV === 'test') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      const res = await fetch(`${config.STOREFRONT_URL.replace(/\/$/, '')}/api/revalidate`, {
        method: 'POST',
        headers: { 'x-revalidate-secret': config.REVALIDATE_SECRET! },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) log.warn({ status: res.status }, 'storefront revalidation was refused');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not reach the storefront to refresh its cache');
    }
  }, 1000);
}
