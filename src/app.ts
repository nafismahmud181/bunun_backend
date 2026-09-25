import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './lib/prisma.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { healthRoutes } from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

export async function buildApp(config: Config, db: Db) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: true, // behind Caddy / Cloudflare in production
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('db', db);
  app.addHook('onClose', async () => {
    await db.$disconnect();
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.CORS_ORIGINS, credentials: true });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Bunun API', version: '0.1.0' },
      servers: [{ url: '/' }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  if (config.NODE_ENV !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(healthRoutes);
  // Versioned API: every public route lives under /api/v1.
  await app.register(catalogueRoutes, { prefix: '/api/v1' });

  return app;
}
