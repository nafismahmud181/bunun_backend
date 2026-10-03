import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrisma } from './lib/prisma.js';
import { createSmsDriver } from './services/sms/index.js';
import { startCourierSync } from './services/shipments.js';
import { startOutboxWorker } from './services/sms/outbox.js';

const config = loadConfig();
const db = createPrisma(config.DATABASE_URL);
const app = await buildApp(config, db);

// Background jobs (sending queued SMS, checking courier parcels) run in this process unless a
// separate `npm run worker` does them.
if (config.SMS_WORKER === 'inline') {
  const stop = startOutboxWorker(db, createSmsDriver(config, app.log), app.log);
  const stopSync = app.courier
    ? startCourierSync(db, app.courier, config.COURIER_SYNC_MINUTES, config.STOREFRONT_URL, app.log)
    : () => {};
  app.addHook('onClose', async () => {
    stop();
    stopSync();
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
