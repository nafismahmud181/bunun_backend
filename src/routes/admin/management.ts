import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ErrorBody } from '../../lib/errors.js';
import { getSettings } from '../../lib/settings.js';
import { bearerToken, requireAdmin } from '../../plugins/admin-auth.js';
import { AuthHeaders } from '../../schemas/admin.js';
import {
  AdminSettings,
  AdminZone,
  AreaZoneBody,
  AuditList,
  AuditQuery,
  BlockBody,
  BlockedContact,
  BlockedCreate,
  CustomerDetail,
  CustomerList,
  CustomerQuery,
  CustomerUpdate,
  Dashboard,
  DistrictZoneBody,
  IdParam,
  ManualOrderBody,
  OneTimePassword,
  PasswordChange,
  SettingsUpdate,
  StaffCreate,
  StaffMember,
  StaffUpdate,
  ZoneCreate,
  ZoneParam,
  ZoneUpdate,
} from '../../schemas/admin-3c.js';
import { OrderReceipt } from '../../schemas/orders.js';
import { listAudit } from '../../services/admin-audit.js';
import { getCustomer, listCustomers, setCustomerBlocked, updateCustomer } from '../../services/admin-customers.js';
import * as settings from '../../services/admin-settings.js';
import * as staff from '../../services/admin-staff.js';
import { dashboard } from '../../services/dashboard.js';
import { createManualOrder } from '../../services/manual-orders.js';
import { notifyStorefront } from '../../services/revalidate.js';

// Part 3c: manual orders, customers, settings, delivery zones, block list, staff, dashboard, audit log.
export const adminManagementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  const ctx = (req: FastifyRequest) => ({ admin: req.admin!, ip: req.ip });
  const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
  const tags = ['admin'];
  const headers = AuthHeaders;
  // Settings and zones are shown on the storefront (delivery fees, free-delivery threshold).
  const refreshStore = () => notifyStorefront(app.config, app.log);

  // ---------- Manual orders ----------

  app.post(
    '/orders',
    {
      preHandler: requireAdmin('orders:write'),
      schema: {
        tags,
        headers,
        summary: 'Enter an order taken on Facebook, WhatsApp or by phone',
        description: '201 for a new order; 200 when the idempotency key was already used (returns that order).',
        body: ManualOrderBody,
        response: { 200: OrderReceipt, 201: OrderReceipt, ...errors },
      },
    },
    async (req, reply) => {
      const { receipt, created } = await createManualOrder(app.db, req.body, {
        ...ctx(req),
        storefrontUrl: app.config.STOREFRONT_URL,
      });
      if (created) refreshStore(); // stock changed
      return reply.code(created ? 201 : 200).send(receipt);
    },
  );

  // ---------- Customers ----------

  app.get(
    '/customers',
    {
      preHandler: requireAdmin('customers:read'),
      schema: {
        tags,
        headers,
        summary: 'Search customers',
        querystring: CustomerQuery,
        response: { 200: CustomerList, ...errors },
      },
    },
    async (req) => listCustomers(app.db, req.query),
  );
  app.get(
    '/customers/:id',
    {
      preHandler: requireAdmin('customers:read'),
      schema: {
        tags,
        headers,
        summary: 'Customer profile, stats and orders',
        params: IdParam,
        response: { 200: CustomerDetail, ...errors },
      },
    },
    async (req) => getCustomer(app.db, req.params.id),
  );
  app.patch(
    '/customers/:id',
    {
      preHandler: requireAdmin('customers:write'),
      schema: {
        tags,
        headers,
        summary: 'Edit name, email or staff notes',
        params: IdParam,
        body: CustomerUpdate,
        response: { 200: CustomerDetail, ...errors },
      },
    },
    async (req) => {
      await updateCustomer(app.db, req.params.id, req.body, ctx(req));
      return getCustomer(app.db, req.params.id);
    },
  );
  app.post(
    '/customers/:id/block',
    {
      preHandler: requireAdmin('customers:write'),
      schema: {
        tags,
        headers,
        summary: 'Block online orders from this phone number',
        params: IdParam,
        body: BlockBody,
        response: { 200: CustomerDetail, ...errors },
      },
    },
    async (req) => {
      await setCustomerBlocked(app.db, req.params.id, true, req.body.reason, ctx(req));
      return getCustomer(app.db, req.params.id);
    },
  );
  app.delete(
    '/customers/:id/block',
    {
      preHandler: requireAdmin('customers:write'),
      schema: { tags, headers, summary: 'Unblock', params: IdParam, response: { 200: CustomerDetail, ...errors } },
    },
    async (req) => {
      await setCustomerBlocked(app.db, req.params.id, false, null, ctx(req));
      return getCustomer(app.db, req.params.id);
    },
  );

  // ---------- Settings, zones, block list ----------

  const settingsWrite = requireAdmin('settings:write');
  app.get(
    '/settings',
    {
      preHandler: settingsWrite,
      schema: { tags, headers, summary: 'All store settings', response: { 200: AdminSettings, ...errors } },
    },
    async () => getSettings(app.db),
  );
  app.patch(
    '/settings',
    {
      preHandler: settingsWrite,
      schema: {
        tags,
        headers,
        summary: 'Change settings',
        body: SettingsUpdate,
        response: { 200: AdminSettings, ...errors },
      },
    },
    async (req) => {
      const out = await settings.updateSettings(app.db, req.body, ctx(req));
      refreshStore();
      return out;
    },
  );

  const zones = () => settings.listZones(app.db);
  const zoneReply = { 200: z.array(AdminZone), ...errors };
  app.get(
    '/delivery-zones',
    { preHandler: settingsWrite, schema: { tags, headers, summary: 'Delivery zones', response: zoneReply } },
    zones,
  );
  app.post(
    '/delivery-zones',
    {
      preHandler: settingsWrite,
      schema: { tags, headers, summary: 'Add a zone', body: ZoneCreate, response: zoneReply },
    },
    async (req) => {
      await settings.createZone(app.db, req.body, ctx(req));
      refreshStore();
      return zones();
    },
  );
  app.patch(
    '/delivery-zones/:key',
    {
      preHandler: settingsWrite,
      schema: {
        tags,
        headers,
        summary: "Change a zone's name, fee or delivery time",
        params: ZoneParam,
        body: ZoneUpdate,
        response: zoneReply,
      },
    },
    async (req) => {
      await settings.updateZone(app.db, req.params.key, req.body, ctx(req));
      refreshStore();
      return zones();
    },
  );
  app.delete(
    '/delivery-zones/:key',
    {
      preHandler: settingsWrite,
      schema: { tags, headers, summary: 'Delete an unused zone', params: ZoneParam, response: zoneReply },
    },
    async (req) => {
      await settings.deleteZone(app.db, req.params.key, ctx(req));
      refreshStore();
      return zones();
    },
  );
  app.put(
    '/delivery-zones/areas',
    {
      preHandler: settingsWrite,
      schema: {
        tags,
        headers,
        summary: "Put areas in a zone (null: their district's zone)",
        body: AreaZoneBody,
        response: zoneReply,
      },
    },
    async (req) => {
      await settings.setAreaZone(app.db, req.body, ctx(req));
      refreshStore();
      return zones();
    },
  );
  app.put(
    '/delivery-zones/districts/:id',
    {
      preHandler: settingsWrite,
      schema: {
        tags,
        headers,
        summary: "Set a district's zone",
        params: IdParam,
        body: DistrictZoneBody,
        response: zoneReply,
      },
    },
    async (req) => {
      await settings.setDistrictZone(app.db, req.params.id, req.body.zoneKey, ctx(req));
      refreshStore();
      return zones();
    },
  );

  const blocked = () => settings.listBlocked(app.db);
  app.get(
    '/blocked',
    {
      preHandler: settingsWrite,
      schema: {
        tags,
        headers,
        summary: 'Blocked phone numbers and IPs',
        response: { 200: z.array(BlockedContact), ...errors },
      },
    },
    blocked,
  );
  app.post(
    '/blocked',
    {
      preHandler: settingsWrite,
      schema: {
        tags,
        headers,
        summary: 'Block a phone number or IP from ordering online',
        body: BlockedCreate,
        response: { 200: z.array(BlockedContact), ...errors },
      },
    },
    async (req) => {
      await settings.addBlocked(app.db, req.body, ctx(req));
      return blocked();
    },
  );
  app.delete(
    '/blocked/:id',
    {
      preHandler: settingsWrite,
      schema: {
        tags,
        headers,
        summary: 'Remove from the block list',
        params: IdParam,
        response: { 200: z.array(BlockedContact), ...errors },
      },
    },
    async (req) => {
      await settings.removeBlocked(app.db, req.params.id, ctx(req));
      return blocked();
    },
  );

  // ---------- Staff ----------

  const staffManage = requireAdmin('staff:manage');
  app.get(
    '/staff',
    {
      preHandler: staffManage,
      schema: { tags, headers, summary: 'Staff accounts', response: { 200: z.array(StaffMember), ...errors } },
    },
    async () => staff.listStaff(app.db),
  );
  app.post(
    '/staff',
    {
      preHandler: staffManage,
      schema: {
        tags,
        headers,
        summary: 'Create an account with a one-time password',
        body: StaffCreate,
        response: { 200: OneTimePassword, ...errors },
      },
    },
    async (req) => staff.inviteStaff(app.db, req.body, ctx(req)),
  );
  app.patch(
    '/staff/:id',
    {
      preHandler: staffManage,
      schema: {
        tags,
        headers,
        summary: 'Rename, change role, disable or enable',
        params: IdParam,
        body: StaffUpdate,
        response: { 200: StaffMember, ...errors },
      },
    },
    async (req) => staff.updateStaff(app.db, req.params.id, req.body, ctx(req)),
  );
  app.post(
    '/staff/:id/reset',
    {
      preHandler: staffManage,
      schema: {
        tags,
        headers,
        summary: 'New one-time password and two-factor setup; signs them out',
        params: IdParam,
        response: { 200: OneTimePassword, ...errors },
      },
    },
    async (req) => staff.resetStaff(app.db, req.params.id, ctx(req)),
  );
  app.post(
    '/staff/:id/sign-out',
    {
      preHandler: staffManage,
      schema: {
        tags,
        headers,
        summary: 'End all their sessions',
        params: IdParam,
        response: { 200: StaffMember, ...errors },
      },
    },
    async (req) => staff.signOutStaff(app.db, req.params.id, ctx(req)),
  );

  app.post(
    '/auth/password',
    {
      preHandler: requireAdmin(),
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags,
        headers,
        summary: 'Change your own password (signs out your other sessions)',
        body: PasswordChange,
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      await staff.changeOwnPassword(app.db, req.body.current, req.body.next, bearerToken(req)!, ctx(req));
      return reply.code(204).send(null);
    },
  );

  // ---------- Dashboard and audit log ----------

  app.get(
    '/dashboard',
    {
      preHandler: requireAdmin('orders:read'),
      schema: {
        tags,
        headers,
        summary: 'Sales, orders, top products, low stock',
        response: { 200: Dashboard, ...errors },
      },
    },
    async () => dashboard(app.db),
  );
  app.get(
    '/audit',
    {
      preHandler: requireAdmin('audit:read'),
      schema: {
        tags,
        headers,
        summary: 'Who did what, when',
        querystring: AuditQuery,
        response: { 200: AuditList, ...errors },
      },
    },
    async (req) => listAudit(app.db, req.query),
  );
};
