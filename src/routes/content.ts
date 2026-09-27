import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { PageParam, PublicContent, PublicPage } from '../schemas/content.js';
import { getPage, publicContent } from '../services/content.js';

// Editable storefront content (CMS). Cached briefly; the admin refreshes the storefront on save.
export const contentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/content',
    {
      schema: {
        tags: ['content'],
        summary: 'Homepage content: sale banner, promo tiles, section order, FAQ',
        response: { 200: PublicContent },
      },
    },
    async (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=60');
      return publicContent(app.db);
    },
  );

  app.get(
    '/pages/:slug',
    {
      schema: {
        tags: ['content'],
        summary: 'A legal or information page (about, privacy, terms, refund-policy)',
        params: PageParam,
        response: { 200: PublicPage },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'public, max-age=60');
      return getPage(app.db, req.params.slug);
    },
  );
};
