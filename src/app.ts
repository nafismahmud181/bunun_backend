import { STATUS_CODES } from 'node:http';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
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
import { cartRoutes } from './routes/cart.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { healthRoutes } from './routes/health.js';
import { orderRoutes } from './routes/orders.js';
import { storeRoutes } from './routes/store.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
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
  app.decorate('config', config);
  app.addHook('onClose', async () => {
    await db.$disconnect();
  });

  await app.register(helmet);
  // The cart uses PUT and DELETE from the browser, which need an explicit allow (the default is GET, HEAD, POST).
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
  });
  // A generous per-IP limit for everything; checkout and order tracking set stricter ones.
  await app.register(rateLimit, {
    global: config.RATE_LIMIT,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'RATE_LIMITED',
      message: `Too many requests. Please try again in ${ctx.after}.`,
    }),
  });

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

  return app;
}
