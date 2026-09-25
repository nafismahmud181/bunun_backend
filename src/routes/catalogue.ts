import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CartVariant,
  Category,
  NotFound,
  ProductDetail,
  ProductList,
  ProductListQuery,
  VariantsQuery,
} from '../schemas/catalogue.js';
import { getProduct, listCategories, listProducts, lookupVariants } from '../services/catalogue.js';

// Public, read-only catalogue. Short shared caching so a CDN can absorb browsing traffic.
const cachePublic = (reply: FastifyReply) => reply.header('Cache-Control', 'public, max-age=60');

export const catalogueRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/categories',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'Active categories with product counts',
        response: { 200: z.array(Category) },
      },
    },
    async (_req, reply) => {
      cachePublic(reply);
      return listCategories(app.db);
    },
  );

  app.get(
    '/products',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'List, filter, search and sort products',
        querystring: ProductListQuery,
        response: { 200: ProductList },
      },
    },
    async (req, reply) => {
      cachePublic(reply);
      return listProducts(app.db, req.query);
    },
  );

  app.get(
    '/products/:slug',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'One product with its variants and images',
        params: z.object({ slug: z.string().max(200) }),
        response: { 200: ProductDetail, 404: NotFound },
      },
    },
    async (req, reply) => {
      const product = await getProduct(app.db, req.params.slug);
      if (!product) return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Product not found' });
      cachePublic(reply);
      return product;
    },
  );

  app.get(
    '/variants',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'Current price and stock for cart items (unknown or hidden SKUs are left out)',
        querystring: VariantsQuery,
        response: { 200: z.array(CartVariant) },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const skus = [...new Set(req.query.skus.split(','))];
      return lookupVariants(app.db, skus);
    },
  );
};
