import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, ErrorBody } from '../../lib/errors.js';
import { requireAdmin } from '../../plugins/admin-auth.js';
import { AuthHeaders } from '../../schemas/admin.js';
import { AdminOrderDetail, OrderNoParams } from '../../schemas/admin-orders.js';
import { getOrderDetail } from '../../services/admin-orders.js';
import { bookShipment, parcelDefaults, refreshShipment, releaseShipment } from '../../services/shipments.js';

const CourierInfo = z
  .object({
    enabled: z.boolean().describe('False until the courier credentials are set on the server'),
    name: z.string().nullable(),
    label: z.string().nullable(),
    mode: z.enum(['sandbox', 'live']).nullable(),
  })
  .meta({ id: 'CourierInfo' });

const ParcelDefaults = z
  .object({
    weightKg: z.number(),
    weightKnown: z.boolean().describe('False when some options have no shipping weight (0.5 kg is assumed)'),
    codAmount: z.number().int(),
    address: z.string(),
    description: z.string(),
  })
  .meta({ id: 'ParcelDefaults' });

const BookBody = z.object({
  weightKg: z.number().min(0.5).max(10).optional().describe('Parcel weight; defaults to the options’ shipping weights'),
  note: z.string().trim().max(200).optional().describe('Extra instruction for the rider'),
});

const ShipmentParams = OrderNoParams.extend({ shipmentId: z.coerce.number().int().positive() });

// Phase 6a: courier booking from the order page.
export const adminShipmentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  const ctx = (req: FastifyRequest) => ({ admin: req.admin!, ip: req.ip, storefrontUrl: app.config.STOREFRONT_URL });
  const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
  const tags = ['admin'];
  const headers = AuthHeaders;

  app.get(
    '/courier',
    {
      preHandler: requireAdmin('orders:read'),
      schema: {
        tags,
        headers,
        summary: 'Which courier is set up (sandbox or live)',
        response: { 200: CourierInfo, ...errors },
      },
    },
    async () => {
      const c = app.courier;
      return { enabled: !!c, name: c?.name ?? null, label: c?.label ?? null, mode: c?.mode ?? null };
    },
  );

  app.get(
    '/orders/:orderNo/parcel',
    {
      preHandler: requireAdmin('orders:read'),
      schema: {
        tags,
        headers,
        summary: 'What a courier booking would send: weight, COD amount, address, contents',
        params: OrderNoParams,
        response: { 200: ParcelDefaults, ...errors },
      },
    },
    async (req) => {
      const d = await parcelDefaults(app.db, req.params.orderNo);
      return {
        weightKg: d.weightKg,
        weightKnown: d.weightKnown,
        codAmount: d.codAmount,
        address: d.address,
        description: d.description,
      };
    },
  );

  app.post(
    '/orders/:orderNo/shipments',
    {
      preHandler: requireAdmin('orders:write'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags,
        headers,
        summary: 'Book the order with the courier',
        description:
          '422 COURIER_REJECTED when the courier refuses (details.fields per field); 502 COURIER_UNKNOWN when it gave no clear answer — the booking then waits until staff check the courier panel.',
        params: OrderNoParams,
        body: BookBody,
        response: { 201: AdminOrderDetail, 422: ErrorBody, 502: ErrorBody, 503: ErrorBody, ...errors },
      },
    },
    async (req, reply) => {
      await bookShipment(app.db, app.courier, req.params.orderNo, req.body, ctx(req));
      return reply.code(201).send(await getOrderDetail(app.db, req.params.orderNo));
    },
  );

  app.post(
    '/orders/:orderNo/shipments/:shipmentId/refresh',
    {
      // Can move the order to shipped/delivered and send SMS, so it's a write.
      preHandler: requireAdmin('orders:write'),
      schema: {
        tags,
        headers,
        summary: 'Ask the courier for the latest status now',
        params: ShipmentParams,
        response: { 200: AdminOrderDetail, 502: ErrorBody, 503: ErrorBody, ...errors },
      },
    },
    async (req) => {
      if (!app.courier) throw new ApiError(503, 'COURIER_OFF', 'Courier booking is not set up on the server.');
      const s = await app.db.shipment.findFirst({
        where: { id: req.params.shipmentId, order: { orderNo: req.params.orderNo.toUpperCase() } },
      });
      if (!s) throw new ApiError(404, 'NOT_FOUND', 'Shipment not found.');
      try {
        await refreshShipment(app.db, app.courier, s, 'staff', app.config.STOREFRONT_URL, req.log);
      } catch (err) {
        throw new ApiError(502, 'COURIER_UNAVAILABLE', (err as Error).message);
      }
      return getOrderDetail(app.db, req.params.orderNo);
    },
  );

  app.post(
    '/orders/:orderNo/shipments/:shipmentId/cancel',
    {
      preHandler: requireAdmin('orders:write'),
      schema: {
        tags,
        headers,
        summary: "Mark a booking as not live at the courier (it wasn't booked, or it was cancelled there)",
        params: ShipmentParams,
        response: { 200: AdminOrderDetail, ...errors },
      },
    },
    async (req) => {
      await releaseShipment(app.db, req.params.orderNo, req.params.shipmentId, ctx(req));
      return getOrderDetail(app.db, req.params.orderNo);
    },
  );
};
