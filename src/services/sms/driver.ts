import type { FastifyBaseLogger } from 'fastify';

/** Sends one SMS. Throw to have the outbox retry later. */
export interface SmsDriver {
  name: string;
  send(to: string, body: string): Promise<{ providerRef?: string }>;
}

/**
 * Writes messages to the log instead of sending them: for development, and until an SMS
 * provider account with an approved sender ID is ready. A provider driver (SSL Wireless,
 * BulkSMSBD, Alpha SMS…) implements the same interface and is chosen with SMS_DRIVER.
 */
export function logDriver(log: FastifyBaseLogger): SmsDriver {
  return {
    name: 'log',
    async send(to, body) {
      log.info({ sms: { to, body } }, 'SMS (log driver, not sent)');
      return {};
    },
  };
}
