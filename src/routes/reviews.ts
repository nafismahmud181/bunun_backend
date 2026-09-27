import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, ErrorBody } from '../lib/errors.js';
import { NotFound } from '../schemas/catalogue.js';
import {
  FeaturedQuery,
  FeaturedReviews,
  MAX_REVIEW_PHOTOS,
  ProductReviews,
  ProductReviewsQuery,
  ReviewableOrder,
  ReviewFields,
  ReviewLookupBody,
  ReviewSubmitted,
} from '../schemas/reviews.js';
import { MAX_UPLOAD_BYTES } from '../services/images.js';
import { featuredReviews, lookupOrderForReview, productReviews, submitReview } from '../services/reviews.js';

// Public reviews. Buyers prove the purchase with the order number and the phone number used,
// the same pair the track-order page uses, so both are rate limited per IP.
export const reviewRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/products/:slug/reviews',
    {
      schema: {
        tags: ['reviews'],
        summary: "A product's approved reviews, newest first, with the star breakdown",
        params: z.object({ slug: z.string().max(200) }),
        querystring: ProductReviewsQuery,
        response: { 200: ProductReviews, 404: NotFound },
      },
    },
    async (req, reply) => {
      const result = await productReviews(app.db, req.params.slug, req.query);
      if (!result) return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Product not found' });
      reply.header('Cache-Control', 'public, max-age=60');
      return result;
    },
  );

  app.get(
    '/reviews/featured',
    {
      schema: {
        tags: ['reviews'],
        summary: 'Recent 4- and 5-star reviews for the homepage, with the store-wide average',
        querystring: FeaturedQuery,
        response: { 200: FeaturedReviews },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'public, max-age=60');
      return featuredReviews(app.db, req.query.limit);
    },
  );

  app.post(
    '/reviews/lookup',
    {
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
      schema: {
        tags: ['reviews'],
        summary: 'The products a delivered order can review (order number + phone)',
        body: ReviewLookupBody,
        response: { 200: ReviewableOrder, 404: ErrorBody, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return lookupOrderForReview(app.db, req.body.orderNo, req.body.phone);
    },
  );

  app.post(
    '/reviews',
    {
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
      schema: {
        tags: ['reviews'],
        summary: 'Submit a review (multipart/form-data)',
        description: `Fields: orderNo, phone, slug, rating (1–5), name, body; up to ${MAX_REVIEW_PHOTOS} image files named "photo" (10 MB each). The review is shown once staff approve it.`,
        consumes: ['multipart/form-data'],
        response: { 201: ReviewSubmitted, 400: ErrorBody, 404: ErrorBody, 409: ErrorBody, 413: ErrorBody },
      },
    },
    async (req, reply) => {
      if (!req.isMultipart()) throw new ApiError(400, 'BAD_REQUEST', 'Send the review as multipart/form-data.');
      const fields: Record<string, string> = {};
      const photos: Buffer[] = [];
      try {
        for await (const part of req.parts({
          limits: { files: MAX_REVIEW_PHOTOS, fields: 10, fileSize: MAX_UPLOAD_BYTES },
        })) {
          if (part.type === 'file') {
            const buffer = await part.toBuffer();
            if (part.file.truncated) throw new ApiError(413, 'FILE_TOO_LARGE', 'Each photo must be 10 MB or smaller.');
            if (part.fieldname === 'photo' && buffer.length) photos.push(buffer);
          } else if (typeof part.value === 'string') {
            fields[part.fieldname] = part.value;
          }
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        const code = (err as { code?: string }).code;
        if (code === 'FST_FILES_LIMIT')
          throw new ApiError(400, 'TOO_MANY_PHOTOS', `Add at most ${MAX_REVIEW_PHOTOS} photos.`);
        if (code === 'FST_REQ_FILE_TOO_LARGE')
          throw new ApiError(413, 'FILE_TOO_LARGE', 'Each photo must be 10 MB or smaller.');
        throw err;
      }
      const parsed = ReviewFields.safeParse(fields);
      if (!parsed.success)
        throw new ApiError(400, 'INVALID_REVIEW', parsed.error.issues[0]?.message ?? 'Please check the form.', {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        });
      const result = await submitReview(app.db, app.images, parsed.data, photos);
      return reply.code(201).send(result);
    },
  );
};
