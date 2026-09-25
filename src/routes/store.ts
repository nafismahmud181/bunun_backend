import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getSettings } from '../lib/settings.js';
import { LocationTree, PublicSettings } from '../schemas/store.js';
import { locationTree } from '../services/delivery.js';

export const storeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/settings',
    {
      schema: {
        tags: ['store'],
        summary: 'Public store settings: free-delivery threshold, hotline, delivery zones',
        response: { 200: PublicSettings },
      },
    },
    async (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=60');
      const [s, zones] = await Promise.all([
        getSettings(app.db),
        app.db.deliveryZone.findMany({ orderBy: [{ sort: 'asc' }, { key: 'asc' }] }),
      ]);
      return {
        freeDeliveryThreshold: s.free_delivery_threshold,
        hotline: s.hotline,
        zones: zones.map((z) => ({ key: z.key, name: z.name, fee: z.fee, estimate: z.estimate })),
      };
    },
  );

  app.get(
    '/locations',
    {
      schema: {
        tags: ['store'],
        summary: 'Divisions → districts → areas for the address picker, with delivery zones',
        response: { 200: LocationTree },
      },
    },
    async (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=3600');
      return locationTree(app.db);
    },
  );
};
