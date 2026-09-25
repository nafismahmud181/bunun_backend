import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody } from '../lib/errors.js';
import {
  CheckoutBody,
  CheckoutHeaders,
  IDEMPOTENCY_HEADER,
  OrderReceipt,
  TrackQuery,
  TrackedOrder,
} from '../schemas/orders.js';
import { placeOrder } from '../services/checkout.js';
import { trackOrder } from '../services/orders.js';

export const orderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/checkout',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['orders'],
        summary: 'Place a Cash on Delivery order from the cart',
        description:
          'Returns 201 for a new order and 200 when the Idempotency-Key was already used (the same order is returned).',
        headers: CheckoutHeaders,
        body: CheckoutBody,
        response: {
          200: OrderReceipt,
          201: OrderReceipt,
          400: ErrorBody,
          403: ErrorBody,
          409: ErrorBody,
          429: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { receipt, created } = await placeOrder(app.db, req.body, {
        cartToken: req.headers['x-cart-token'],
        idempotencyKey: req.headers[IDEMPOTENCY_HEADER],
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        storefrontUrl: app.config.STOREFRONT_URL,
      });
      return reply.code(created ? 201 : 200).send(receipt);
    },
  );

  app.get(
    '/orders/track',
    {
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
      schema: {
        tags: ['orders'],
        summary: 'Order status by order number and the phone number used',
        querystring: TrackQuery,
        response: { 200: TrackedOrder, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const order = await trackOrder(app.db, req.query.orderNo, req.query.phone);
      if (!order)
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          code: 'ORDER_NOT_FOUND',
          message: 'No order matches that order number and phone number.',
        });
      return order;
    },
  );
};
