import type { FastifyBaseLogger } from 'fastify';
import { maskPhone } from '../../lib/mask.js';

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
      // Masked: logs are kept and shared more widely than the database.
      log.info({ sms: { to: maskPhone(to), body } }, 'SMS (log driver, not sent)');
      return {};
    },
  };
}
