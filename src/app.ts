import { STATUS_CODES } from 'node:http';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
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
import { ApiError } from './lib/errors.js';
import type { Db } from './lib/prisma.js';
import { MAX_UPLOAD_BYTES } from './services/images.js';
import { createImageStore, type ImageStore } from './services/storage.js';
import { adminAuthRoutes } from './routes/admin/auth.js';
import { adminCatalogueRoutes } from './routes/admin/catalogue.js';
import { adminOrderRoutes } from './routes/admin/orders.js';
import { cartRoutes } from './routes/cart.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { healthRoutes } from './routes/health.js';
import { orderRoutes } from './routes/orders.js';
import { storeRoutes } from './routes/store.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Where uploaded images go; null when storage isn't configured (uploads are refused). */
    images: ImageStore | null;
  }
}

export async function buildApp(config: Config, db: Db, images: ImageStore | null = createImageStore(config)) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('images', images);
  app.decorateRequest('admin', null);
  app.addHook('onClose', async () => {
    await db.$disconnect();
  });

  await app.register(helmet);
  // Image uploads (admin only): one file per request, at most 10 MB.
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });
  // The cart uses PUT and DELETE from the browser, which need an explicit allow (the default is GET, HEAD, POST).
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
  });
  // A generous per-IP limit for everything; sign-in, checkout and order tracking set stricter ones
  // (route `config.rateLimit`). Not registered at all when turned off, so those don't apply either.
  if (config.RATE_LIMIT) {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
      // Thrown as an ApiError so the error handler below formats it like every other error.
      errorResponseBuilder: (_req, ctx) =>
        new ApiError(429, 'RATE_LIMITED', `Too many requests. Please try again in ${ctx.after}.`),
    });
  }

  // Service errors carry their own status and code; everything else keeps Fastify's handling.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        statusCode: err.statusCode,
        error: STATUS_CODES[err.statusCode] ?? 'Error',
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.send(err);
  });

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
  await app.register(storeRoutes, { prefix: '/api/v1' });
  await app.register(cartRoutes, { prefix: '/api/v1' });
  await app.register(orderRoutes, { prefix: '/api/v1' });
  // Staff API. Every route requires a signed-in admin with the right permission (see plugins/admin-auth.ts).
  await app.register(adminAuthRoutes, { prefix: '/api/v1/admin' });
  await app.register(adminOrderRoutes, { prefix: '/api/v1/admin' });
  await app.register(adminCatalogueRoutes, { prefix: '/api/v1/admin' });

  return app;
}
