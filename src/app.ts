import { STATUS_CODES } from 'node:http';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import * as Sentry from '@sentry/node';
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
import { adminManagementRoutes } from './routes/admin/management.js';
import { adminMarketingRoutes } from './routes/admin/marketing.js';
import { adminContentRoutes } from './routes/admin/content.js';
import { adminOrderRoutes } from './routes/admin/orders.js';
import { cartRoutes } from './routes/cart.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { healthRoutes } from './routes/health.js';
import { orderRoutes } from './routes/orders.js';
import { reviewRoutes } from './routes/reviews.js';
import { contentRoutes } from './routes/content.js';
import { webhookRoutes } from './routes/webhooks.js';
import { adminShipmentRoutes } from './routes/admin/shipments.js';
import { type CourierDriver, createCourier } from './services/courier/index.js';
import { storeRoutes } from './routes/store.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Where uploaded images go; null when storage isn't configured (uploads are refused). */
    images: ImageStore | null;
    /** The courier parcels are booked with; null when it isn't configured (booking is refused). */
    courier: CourierDriver | null;
  }
}

export async function buildApp(
  config: Config,
  db: Db,
  images: ImageStore | null = createImageStore(config),
  courier: CourierDriver | null = createCourier(config, db),
) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Log the path without its query string: order tracking and the cart quote carry phone numbers there.
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url.split('?')[0],
          host: req.host,
          remoteAddress: req.ip,
        }),
      },
    },
    trustProxy: config.TRUST_PROXY,
    // Product slugs can be up to 120 characters (admin) and are read as up to 200 (public routes);
    // Fastify's default of 100 answered longer ones with 414 URI Too Long.
    routerOptions: { maxParamLength: 200 },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('images', images);
  app.decorate('courier', courier);
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
      // Inherited by the stricter per-route limits too.
      ...(config.RATE_LIMIT_ALLOWLIST.length && { allowList: config.RATE_LIMIT_ALLOWLIST }),
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
    if (status < 500) return reply.send(err); // Fastify's own 4xx (bad JSON, too large…): safe to show
    // Unexpected failures: details go to the log and Sentry, never to the visitor (they can name
    // database tables, storage responses or settings).
    req.log.error({ err }, 'request failed');
    Sentry.captureException(err, { tags: { route: req.routeOptions.url ?? 'unknown' } });
    return reply.code(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'INTERNAL',
      message: 'Something went wrong on our side. Please try again.',
    });
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
  await app.register(reviewRoutes, { prefix: '/api/v1' });
  await app.register(contentRoutes, { prefix: '/api/v1' });
  await app.register(webhookRoutes, { prefix: '/api/v1' });
  // Staff API. Every route requires a signed-in admin with the right permission (see plugins/admin-auth.ts).
  await app.register(adminAuthRoutes, { prefix: '/api/v1/admin' });
  await app.register(adminOrderRoutes, { prefix: '/api/v1/admin' });
  await app.register(adminCatalogueRoutes, { prefix: '/api/v1/admin' });
  await app.register(adminManagementRoutes, { prefix: '/api/v1/admin' });
  await app.register(adminMarketingRoutes, { prefix: '/api/v1/admin' });
  await app.register(adminContentRoutes, { prefix: '/api/v1/admin' });
  await app.register(adminShipmentRoutes, { prefix: '/api/v1/admin' });

  return app;
}
