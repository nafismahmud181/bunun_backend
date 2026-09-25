// Standalone SMS outbox worker (`npm run worker`), for running it apart from the API with
// SMS_WORKER=off on the API. By default the API runs the worker itself.
import pino from 'pino';
import { loadConfig } from './config.js';
import { createPrisma } from './lib/prisma.js';
import { createSmsDriver } from './services/sms/index.js';
import { startOutboxWorker } from './services/sms/outbox.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const db = createPrisma(config.DATABASE_URL);
const stop = startOutboxWorker(db, createSmsDriver(config, log), log);
log.info({ driver: config.SMS_DRIVER }, 'SMS worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stop();
    await db.$disconnect();
    process.exit(0);
  });
}
