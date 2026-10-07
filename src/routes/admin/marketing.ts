import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ErrorBody } from '../../lib/errors.js';
import { maskPhone } from '../../lib/mask.js';
import { can } from '../../lib/permissions.js';
import { requireAdmin } from '../../plugins/admin-auth.js';
import { IdParam } from '../../schemas/admin-3c.js';
import {
  AdminCoupon,
  AdminReview,
  AdminReviewList,
  CouponCreate,
  CouponDetail,
  CouponListQuery,
  CouponUpdate,
  ModerateBody,
  ReviewListQuery,
} from '../../schemas/admin-5a.js';
import { AuthHeaders } from '../../schemas/admin.js';
import * as coupons from '../../services/admin-coupons.js';
import { deleteReview, listReviews, moderateReview } from '../../services/admin-reviews.js';
import { notifyStorefront } from '../../services/revalidate.js';

// Part 5a: coupons and the review approval queue.
export const adminMarketingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  const ctx = (req: FastifyRequest) => ({ admin: req.admin!, ip: req.ip });
  // Customer phone numbers only for roles that may see customers; others get them masked.
  const phoneFor = (req: FastifyRequest, permission: 'customers:read' | 'orders:read') => (phone: string) =>
    can(req.admin!.role, permission) ? phone : maskPhone(phone);
  const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
  const tags = ['admin'];
  const headers = AuthHeaders;
  // Approved reviews and star ratings show on product pages.
  const refreshStore = () => notifyStorefront(app.config, app.log);

  // ---------- Coupons ----------

  const couponsOnly = requireAdmin('coupons:write');
  app.get(
    '/coupons',
    {
      preHandler: couponsOnly,
      schema: {
        tags,
        headers,
        summary: 'Coupons with their state and usage',
        querystring: CouponListQuery,
        response: { 200: z.array(AdminCoupon), ...errors },
      },
    },
    async (req) => coupons.listCoupons(app.db, req.query),
  );
  app.get(
    '/coupons/:id',
    {
      preHandler: couponsOnly,
      schema: {
        tags,
        headers,
        summary: 'A coupon with the orders that used it',
        params: IdParam,
        response: { 200: CouponDetail, ...errors },
      },
    },
    async (req) => {
      const coupon = await coupons.getCoupon(app.db, req.params.id);
      const show = phoneFor(req, 'orders:read');
      return { ...coupon, redemptions: coupon.redemptions.map((r) => ({ ...r, phone: show(r.phone) })) };
    },
  );
  app.post(
    '/coupons',
    {
      preHandler: couponsOnly,
      schema: {
        tags,
        headers,
        summary: 'Create a coupon',
        body: CouponCreate,
        response: { 201: CouponDetail, ...errors },
      },
    },
    async (req, reply) => reply.code(201).send(await coupons.createCoupon(app.db, req.body, ctx(req))),
  );
  app.patch(
    '/coupons/:id',
    {
      preHandler: couponsOnly,
      schema: {
        tags,
        headers,
        summary: 'Edit a coupon (its discount is fixed once used)',
        params: IdParam,
        body: CouponUpdate,
        response: { 200: CouponDetail, ...errors },
      },
    },
    async (req) => coupons.updateCoupon(app.db, req.params.id, req.body, ctx(req)),
  );
  app.delete(
    '/coupons/:id',
    {
      preHandler: couponsOnly,
      schema: {
        tags,
        headers,
        summary: 'Delete a coupon no order has used',
        params: IdParam,
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      await coupons.deleteCoupon(app.db, req.params.id, ctx(req));
      return reply.code(204).send(null);
    },
  );

  // ---------- Reviews ----------

  const reviewers = requireAdmin('products:write');
  app.get(
    '/reviews',
    {
      preHandler: reviewers,
      schema: {
        tags,
        headers,
        summary: 'Reviews by status (the pending queue oldest first)',
        querystring: ReviewListQuery,
        response: { 200: AdminReviewList, ...errors },
      },
    },
    async (req) => {
      const list = await listReviews(app.db, req.query);
      const show = phoneFor(req, 'customers:read');
      return { ...list, items: list.items.map((r) => ({ ...r, phone: r.phone && show(r.phone) })) };
    },
  );
  app.patch(
    '/reviews/:id',
    {
      preHandler: reviewers,
      schema: {
        tags,
        headers,
        summary: 'Approve or reject a review',
        params: IdParam,
        body: ModerateBody,
        response: { 200: AdminReview, ...errors },
      },
    },
    async (req) => {
      const review = await moderateReview(app.db, req.params.id, req.body.status, ctx(req));
      refreshStore();
      return { ...review, phone: review.phone && phoneFor(req, 'customers:read')(review.phone) };
    },
  );
  app.delete(
    '/reviews/:id',
    {
      preHandler: reviewers,
      schema: {
        tags,
        headers,
        summary: 'Delete a review and its photos',
        params: IdParam,
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      const wasVisible = await deleteReview(app.db, app.images, req.params.id, ctx(req));
      if (wasVisible) refreshStore();
      return reply.code(204).send(null);
    },
  );
};
