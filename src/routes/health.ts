import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.enum(['up', 'down']),
  uptimeSeconds: z.number(),
});

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness and database check',
        response: { 200: HealthResponse, 503: HealthResponse },
      },
    },
    async (_req, reply) => {
      let database: 'up' | 'down' = 'up';
      try {
        await app.db.$queryRaw`SELECT 1`;
      } catch (err) {
        app.log.error({ err }, 'health check: database unreachable');
        database = 'down';
      }
      const body = {
        status: database === 'up' ? ('ok' as const) : ('degraded' as const),
        database,
        uptimeSeconds: Math.round(process.uptime()),
      };
      return reply.code(database === 'up' ? 200 : 503).send(body);
    },
  );
};
