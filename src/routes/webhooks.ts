import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { refreshByConsignment } from '../services/shipments.js';

// Pathao calls this when a parcel's status changes (Pathao Merchant → Developer's API → Webhook).
// Its signature header is the same for every merchant, so it proves nothing: the body is only a
// hint. We answer at once and then ask Pathao's API for the parcel's real status.
export const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/webhooks/pathao',
    {
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      schema: {
        tags: ['webhooks'],
        summary: 'Pathao parcel status updates',
        body: z.looseObject({ event: z.string().optional(), consignment_id: z.string().optional() }),
        response: { 202: z.object({ received: z.boolean() }) },
      },
    },
    async (req, reply) => {
      // Pathao checks the integration by expecting this header back with the secret it was given.
      if (app.config.PATHAO_WEBHOOK_SECRET)
        reply.header('X-Pathao-Merchant-Webhook-Integration-Secret', app.config.PATHAO_WEBHOOK_SECRET);
      const { event, consignment_id: consignmentId } = req.body;
      if (event !== 'webhook_integration' && consignmentId && app.courier) {
        const courier = app.courier;
        // Don't make Pathao wait (it allows 10 s): refresh in the background.
        void refreshByConsignment(app.db, courier, consignmentId, app.config.STOREFRONT_URL, req.log).catch((err) =>
          req.log.warn({ err, consignmentId }, 'webhook refresh failed'),
        );
      }
      return reply.code(202).send({ received: true });
    },
  );
};
