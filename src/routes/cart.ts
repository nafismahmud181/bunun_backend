import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import {
  AddItemBody,
  CART_TOKEN_HEADER,
  CartHeaders,
  CartView,
  Quote,
  QuoteQuery,
  SetQtyBody,
  SkuParams,
} from '../schemas/cart.js';
import { cartView, changeItem, findCart } from '../services/cart.js';
import { deliveryFee, resolveArea } from '../services/delivery.js';

// The guest cart. The browser sends its token in the X-Cart-Token header; a request that
// adds the first item without a token creates the cart and returns the token once.
export const cartRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.get(
    '/cart',
    { schema: { tags: ['cart'], summary: 'The current cart', headers: CartHeaders, response: { 200: CartView } } },
    async (req) => {
      const cart = await findCart(app.db, req.headers[CART_TOKEN_HEADER]);
      return cartView(app.db, cart?.id ?? null);
    },
  );

  app.post(
    '/cart/items',
    {
      schema: {
        tags: ['cart'],
        summary: 'Add units of a variant (creates the cart if needed)',
        headers: CartHeaders,
        body: AddItemBody,
        response: { 200: CartView, 404: ErrorBody, 409: ErrorBody, 400: ErrorBody },
      },
    },
    async (req) => changeItem(app.db, req.headers[CART_TOKEN_HEADER], req.body.sku, req.body.qty, 'add'),
  );

  app.put(
    '/cart/items/:sku',
    {
      schema: {
        tags: ['cart'],
        summary: 'Set the quantity of a variant (0 removes it)',
        headers: CartHeaders,
        params: SkuParams,
        body: SetQtyBody,
        response: { 200: CartView, 404: ErrorBody, 409: ErrorBody, 400: ErrorBody },
      },
    },
    async (req) => changeItem(app.db, req.headers[CART_TOKEN_HEADER], req.params.sku, req.body.qty, 'set'),
  );

  app.delete(
    '/cart/items/:sku',
    {
      schema: {
        tags: ['cart'],
        summary: 'Remove a variant from the cart',
        headers: CartHeaders,
        params: SkuParams,
        response: { 200: CartView, 404: ErrorBody },
      },
    },
    async (req) => changeItem(app.db, req.headers[CART_TOKEN_HEADER], req.params.sku, 0, 'set'),
  );

  app.get(
    '/cart/quote',
    {
      schema: {
        tags: ['cart'],
        summary: 'Delivery fee and total for the cart, delivered to an area',
        headers: CartHeaders,
        querystring: QuoteQuery,
        response: { 200: Quote, 400: ErrorBody },
      },
    },
    async (req) => {
      const cart = await findCart(app.db, req.headers[CART_TOKEN_HEADER]);
      const [view, { zone }, settings] = await Promise.all([
        cartView(app.db, cart?.id ?? null),
        resolveArea(app.db, req.query.areaId),
        getSettings(app.db),
      ]);
      const fee = deliveryFee(view.subtotal, zone.fee, settings.free_delivery_threshold);
      return {
        subtotal: view.subtotal,
        deliveryFee: fee,
        total: view.subtotal + fee,
        freeDelivery: view.subtotal > 0 && fee === 0,
        zone: { key: zone.key, name: zone.name, estimate: zone.estimate },
      };
    },
  );
};
