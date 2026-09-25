import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrisma } from './lib/prisma.js';
import { createSmsDriver } from './services/sms/index.js';
import { startOutboxWorker } from './services/sms/outbox.js';

const config = loadConfig();
const db = createPrisma(config.DATABASE_URL);
const app = await buildApp(config, db);

// Send queued SMS from this process unless a separate `npm run worker` does it.
if (config.SMS_WORKER === 'inline') {
  const stop = startOutboxWorker(db, createSmsDriver(config, app.log), app.log);
  app.addHook('onClose', async () => stop());
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
