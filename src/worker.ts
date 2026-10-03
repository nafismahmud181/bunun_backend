// Standalone background worker (SMS outbox, courier status sync) (`npm run worker`), for running it apart from the API with
// SMS_WORKER=off on the API. By default the API runs the worker itself.
import pino from 'pino';
import { loadConfig } from './config.js';
import { createPrisma } from './lib/prisma.js';
import { createSmsDriver } from './services/sms/index.js';
import { createCourier } from './services/courier/index.js';
import { startCourierSync } from './services/shipments.js';
import { startOutboxWorker } from './services/sms/outbox.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const db = createPrisma(config.DATABASE_URL);
const stop = startOutboxWorker(db, createSmsDriver(config, log), log);
log.info({ driver: config.SMS_DRIVER }, 'SMS worker started');
const courier = createCourier(config, db);
const stopSync = courier
  ? startCourierSync(db, courier, config.COURIER_SYNC_MINUTES, config.STOREFRONT_URL, log)
  : () => {};
if (courier) log.info({ courier: courier.name, mode: courier.mode }, 'courier status sync started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stop();
    stopSync();
    await db.$disconnect();
    process.exit(0);
  });
}
