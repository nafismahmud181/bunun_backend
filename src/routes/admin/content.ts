import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, ErrorBody } from '../../lib/errors.js';
import { requireAdmin } from '../../plugins/admin-auth.js';
import { AuthHeaders } from '../../schemas/admin.js';
import {
  AdminContent,
  AdminPage,
  AdminPageSummary,
  FaqBody,
  HeroBody,
  PageParam,
  PageUpdate,
  ProductSectionKey,
  SectionProducts,
  SectionProductsBody,
  PromosBody,
  SectionsBody,
  UploadedImage,
} from '../../schemas/content.js';
import {
  adminContent,
  getPage,
  listPages,
  resetContent,
  saveContent,
  savePage,
  listSectionProducts,
  setSectionProducts,
} from '../../services/content.js';
import { storeImage } from '../../services/images.js';
import { notifyStorefront } from '../../services/revalidate.js';

// Part 5b: the CMS. Everything here shows on the storefront, so each save refreshes it.
export const adminContentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  const ctx = (req: FastifyRequest) => ({ admin: req.admin!, ip: req.ip });
  const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
  const tags = ['admin'];
  const headers = AuthHeaders;
  const editors = requireAdmin('content:write');
  const refreshStore = () => notifyStorefront(app.config, app.log);

  app.get(
    '/content',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Every content block (defaults where unsaved)',
        response: { 200: AdminContent, ...errors },
      },
    },
    async () => adminContent(app.db),
  );

  const save =
    <K extends 'hero' | 'promos' | 'homepage_sections' | 'faq'>(key: K) =>
    async (value: Parameters<typeof saveContent<K>>[3], req: FastifyRequest) => {
      const result = await saveContent(app.db, app.images, key, value, ctx(req));
      refreshStore();
      return result;
    };

  app.put(
    '/content/hero',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Save the sale banner and countdown',
        body: HeroBody,
        response: { 200: AdminContent, ...errors },
      },
    },
    async (req) => save('hero')(req.body, req),
  );
  app.put(
    '/content/promos',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Save the promo tiles (up to 4)',
        body: PromosBody,
        response: { 200: AdminContent, ...errors },
      },
    },
    async (req) => save('promos')(req.body.promos, req),
  );
  app.put(
    '/content/sections',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Save the order and visibility of homepage sections',
        body: SectionsBody,
        response: { 200: AdminContent, ...errors },
      },
    },
    async (req) => save('homepage_sections')(req.body.sections, req),
  );
  app.put(
    '/content/faq',
    {
      preHandler: editors,
      schema: { tags, headers, summary: 'Save the FAQ', body: FaqBody, response: { 200: AdminContent, ...errors } },
    },
    async (req) => save('faq')(req.body.faq, req),
  );
  app.delete(
    '/content/:key',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Put a block back to its default',
        params: z.object({ key: z.enum(['hero', 'promos', 'homepage_sections', 'faq']) }),
        response: { 200: AdminContent, ...errors },
      },
    },
    async (req) => {
      const result = await resetContent(app.db, app.images, req.params.key, ctx(req));
      refreshStore();
      return result;
    },
  );

  app.post(
    '/content/images',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Upload an image for a promo tile (multipart field "file")',
        consumes: ['multipart/form-data'],
        response: { 201: UploadedImage, 413: ErrorBody, 503: ErrorBody, ...errors },
      },
    },
    async (req, reply) => {
      if (!app.images) throw new ApiError(503, 'STORAGE_OFF', 'Image storage is not set up on the server.');
      if (!req.isMultipart()) throw new ApiError(400, 'NO_FILE', 'Send the image as multipart/form-data.');
      const file = await req.file();
      if (!file) throw new ApiError(400, 'NO_FILE', 'Choose an image to upload.');
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        throw new ApiError(413, 'FILE_TOO_LARGE', 'The image is larger than 10 MB.');
      }
      return reply.code(201).send({ url: await storeImage(app.images, 'content', buffer) });
    },
  );

  app.get(
    '/content/section-products',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Products hand-picked for the Best sellers and New arrivals sections',
        response: { 200: SectionProducts, ...errors },
      },
    },
    async () => listSectionProducts(app.db),
  );
  app.put(
    '/content/section-products/:key',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Set the products (in order) of a homepage section',
        params: z.object({ key: ProductSectionKey }),
        body: SectionProductsBody,
        response: { 200: SectionProducts, ...errors },
      },
    },
    async (req) => {
      const result = await setSectionProducts(app.db, req.params.key, req.body.productIds, ctx(req));
      refreshStore();
      return result;
    },
  );

  // ---------- Pages ----------

  app.get(
    '/pages',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Legal and information pages',
        response: { 200: z.array(AdminPageSummary), ...errors },
      },
    },
    async () => listPages(app.db),
  );
  app.get(
    '/pages/:slug',
    {
      preHandler: editors,
      schema: { tags, headers, summary: 'One page', params: PageParam, response: { 200: AdminPage, ...errors } },
    },
    async (req) => getPage(app.db, req.params.slug),
  );
  app.put(
    '/pages/:slug',
    {
      preHandler: editors,
      schema: {
        tags,
        headers,
        summary: 'Save a page',
        params: PageParam,
        body: PageUpdate,
        response: { 200: AdminPage, ...errors },
      },
    },
    async (req) => {
      const page = await savePage(app.db, req.params.slug, req.body, ctx(req));
      refreshStore();
      return page;
    },
  );
};
