import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody } from '../../lib/errors.js';
import { requireAdmin } from '../../plugins/admin-auth.js';
import { AuthHeaders } from '../../schemas/admin.js';
import {
  AdminOrderDetail,
  AdminOrderList,
  NoteBody,
  OrderEditBody,
  OrderListQuery,
  OrderNoParams,
  StatusChangeBody,
} from '../../schemas/admin-orders.js';
import {
  addNote,
  changeStatus,
  editOrder,
  exportOrdersCsv,
  getOrderDetail,
  listOrders,
} from '../../services/admin-orders.js';

export const adminOrderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  const ctx = (req: { admin: import('../../generated/prisma/client.js').AdminUser | null; ip: string }) => ({
    admin: req.admin!,
    ip: req.ip,
    storefrontUrl: app.config.STOREFRONT_URL,
  });
  const errors = { 401: ErrorBody, 403: ErrorBody, 404: ErrorBody };

  app.get(
    '/orders',
    {
      preHandler: requireAdmin('orders:read'),
      schema: {
        tags: ['admin'],
        summary: 'Search and filter orders (newest first)',
        headers: AuthHeaders,
        querystring: OrderListQuery,
        response: { 200: AdminOrderList, ...errors },
      },
    },
    async (req) => listOrders(app.db, req.query),
  );

  app.get(
    '/orders/export.csv',
    {
      preHandler: requireAdmin('orders:read'),
      schema: {
        tags: ['admin'],
        summary: 'The same search as CSV (at most 5,000 rows)',
        headers: AuthHeaders,
        querystring: OrderListQuery,
      },
    },
    async (req, reply) => {
      const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="bunon-orders-${day}.csv"`);
      return exportOrdersCsv(app.db, req.query);
    },
  );

  app.get(
    '/orders/:orderNo',
    {
      preHandler: requireAdmin('orders:read'),
      schema: {
        tags: ['admin'],
        summary: 'One order with items, history, notes and customer summary',
        headers: AuthHeaders,
        params: OrderNoParams,
        response: { 200: AdminOrderDetail, ...errors },
      },
    },
    async (req) => getOrderDetail(app.db, req.params.orderNo),
  );

  app.post(
    '/orders/:orderNo/status',
    {
      preHandler: requireAdmin('orders:write'),
      schema: {
        tags: ['admin'],
        summary: 'Move the order to its next status',
        headers: AuthHeaders,
        params: OrderNoParams,
        body: StatusChangeBody,
        response: { 200: AdminOrderDetail, 409: ErrorBody, ...errors },
      },
    },
    async (req) => changeStatus(app.db, req.params.orderNo, req.body, ctx(req)),
  );

  app.post(
    '/orders/:orderNo/notes',
    {
      preHandler: requireAdmin('orders:write'),
      schema: {
        tags: ['admin'],
        summary: 'Add an internal staff note',
        headers: AuthHeaders,
        params: OrderNoParams,
        body: NoteBody,
        response: { 200: AdminOrderDetail, ...errors },
      },
    },
    async (req) => addNote(app.db, req.params.orderNo, req.body.body, ctx(req)),
  );

  app.patch(
    '/orders/:orderNo',
    {
      preHandler: requireAdmin('orders:write'),
      schema: {
        tags: ['admin'],
        summary: 'Correct contact or address details (pending or confirmed orders only)',
        headers: AuthHeaders,
        params: OrderNoParams,
        body: OrderEditBody,
        response: { 200: AdminOrderDetail, 400: ErrorBody, 409: ErrorBody, ...errors },
      },
    },
    async (req) => editOrder(app.db, req.params.orderNo, req.body, ctx(req)),
  );
};
