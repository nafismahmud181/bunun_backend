import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../lib/prisma.js';
import type { SmsDriver } from './driver.js';

/** Give up after this many attempts and mark the message failed. */
export const MAX_ATTEMPTS = 5;
const BATCH = 10;

/**
 * Sends due messages from the sms_messages outbox. Each run claims a batch with
 * FOR UPDATE SKIP LOCKED and pushes their next attempt 5 minutes ahead, so several workers never
 * send the same message, and a worker that dies mid-send only delays it. Failures retry with
 * growing gaps (1, 2, 4, 8 minutes).
 */
export async function processOutbox(db: Db, driver: SmsDriver, log: FastifyBaseLogger) {
  const claimed = await db.$queryRaw<{ id: number; to: string; body: string; attempts: number }[]>`
    UPDATE sms_messages
    SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
    WHERE id IN (
      SELECT id FROM sms_messages
      WHERE status = 'queued' AND next_attempt_at <= now()
      ORDER BY id
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "to", body, attempts`;

  for (const m of claimed) {
    try {
      const { providerRef } = await driver.send(m.to, m.body);
      await db.smsMessage.update({
        where: { id: m.id },
        data: { status: 'sent', sentAt: new Date(), providerRef: providerRef ?? driver.name, lastError: null },
      });
    } catch (err) {
      const giveUp = m.attempts >= MAX_ATTEMPTS;
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { smsId: m.id, attempt: m.attempts, err: message },
        giveUp ? 'SMS failed, giving up' : 'SMS failed, will retry',
      );
      await db.smsMessage.update({
        where: { id: m.id },
        data: {
          lastError: message.slice(0, 500),
          ...(giveUp ? { status: 'failed' } : { nextAttemptAt: new Date(Date.now() + 2 ** (m.attempts - 1) * 60_000) }),
        },
      });
    }
  }
  return claimed.length;
}

/** Runs processOutbox every few seconds until the returned stop function is called. */
export function startOutboxWorker(db: Db, driver: SmsDriver, log: FastifyBaseLogger, everyMs = 5_000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Keep going while full batches come back, so a backlog drains quickly.
      while ((await processOutbox(db, driver, log)) === BATCH);
    } catch (err) {
      log.error({ err }, 'SMS outbox run failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, everyMs);
  void tick();
  return () => clearInterval(timer);
}
