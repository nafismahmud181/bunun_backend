import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrisma } from './lib/prisma.js';

const config = loadConfig();
const app = await buildApp(config, createPrisma(config.DATABASE_URL));

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
