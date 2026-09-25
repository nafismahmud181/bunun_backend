import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import { logDriver, type SmsDriver } from './driver.js';

/** The SMS driver chosen by SMS_DRIVER. Add provider drivers here once an account is ready. */
export function createSmsDriver(config: Config, log: FastifyBaseLogger): SmsDriver {
  switch (config.SMS_DRIVER) {
    case 'log':
      return logDriver(log);
  }
}
