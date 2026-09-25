import { z } from 'zod';
import { AdminRole } from './admin.js';
import { BdPhone, OrderStatus } from './orders.js';

const Money = z.number().int().describe('Whole taka');
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const IdParam = z.object({ id: z.coerce.number().int().positive() });

// ---------- Manual orders ----------

export const ManualOrderBody = z.object({
  source: z.enum(['facebook', 'whatsapp', 'phone', 'other']),
  name: z.string().trim().min(2).max(80),
  phone: BdPhone,
  areaId: z.number().int().positive(),
  address: z.string().trim().min(5).max(300),
  notes: z.string().trim().max(500).optional(),
  items: z
    .array(z.object({ sku: z.string().trim().toUpperCase().max(64), qty: z.number().int().min(1).max(100) }))
    .min(1)
    .max(50),
  discount: Money.min(0).default(0).describe('Taken off the item total, e.g. a Facebook deal'),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/)
    .describe('New random value per order; resend it when retrying so the order is not created twice'),
});

// ---------- Customers ----------

export const CustomerQuery = z.object({
  q: z.string().trim().max(100).optional().describe('Phone or name'),
  blocked: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const CustomerStats = {
  orders: z.number().int(),
  delivered: z.number().int(),
  cancelled: z.number().int(),
  returned: z.number().int(),
  spent: Money.describe('Total of delivered orders'),
  lastOrderAt: z.string().nullable(),
};

export const CustomerRow = z
  .object({ id: z.number().int(), name: z.string(), phone: z.string(), blocked: z.boolean(), ...CustomerStats })
  .meta({ id: 'CustomerRow' });

export const CustomerList = z
  .object({ items: z.array(CustomerRow), total: z.number().int(), page: z.number().int(), limit: z.number().int() })
  .meta({ id: 'CustomerList' });

export const CustomerDetail = z
  .object({
    id: z.number().int(),
    name: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    blocked: z.object({ reason: z.string().nullable(), since: z.string() }).nullable(),
    ...CustomerStats,
    orders: z.number().int(),
    recentOrders: z.array(
      z.object({
        orderNo: z.string(),
        createdAt: z.string(),
        total: Money,
        status: OrderStatus,
        source: z.string(),
        items: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'CustomerDetail' });

export const CustomerUpdate = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().email().max(200).nullable(),
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const BlockBody = z.object({ reason: z.string().trim().min(3).max(200) });

// ---------- Settings, zones, blocked contacts ----------

export const AdminSettings = z
  .object({
    free_delivery_threshold: Money,
    hotline: z.string(),
    order_limit_per_phone_24h: z.number().int(),
    order_limit_per_ip_1h: z.number().int(),
    low_stock_threshold: z.number().int(),
    store_name: z.string(),
    store_address: z.string(),
    store_email: z.string(),
    trade_licence: z.string(),
  })
  .meta({ id: 'AdminSettings' });

export const SettingsUpdate = z
  .object({
    free_delivery_threshold: z.number().int().min(0).max(1_000_000),
    hotline: z.string().trim().min(5).max(40),
    order_limit_per_phone_24h: z.number().int().min(1).max(1000),
    order_limit_per_ip_1h: z.number().int().min(1).max(1000),
    low_stock_threshold: z.number().int().min(0).max(10_000),
    store_name: z.string().trim().min(2).max(80),
    store_address: z.string().trim().min(5).max(200),
    store_email: z.string().trim().email().max(200),
    trade_licence: z.string().trim().max(80),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const AdminZone = z
  .object({
    key: z.string(),
    name: z.string(),
    fee: Money,
    estimate: z.string(),
    sort: z.number().int(),
    areas: z.number().int().describe('Areas set to this zone directly'),
    districts: z.number().int().describe('Districts set to this zone'),
  })
  .meta({ id: 'AdminZone' });

export const ZoneCreate = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(40),
  name: z.string().trim().min(2).max(60),
  fee: z.number().int().min(0).max(100_000),
  estimate: z.string().trim().min(2).max(40),
});
export const ZoneUpdate = ZoneCreate.omit({ key: true })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export const ZoneParam = z.object({ key: z.string().max(40) });

export const AreaZoneBody = z.object({
  areaIds: z.array(z.number().int().positive()).min(1).max(1000),
  zoneKey: z.string().max(40).nullable().describe("null: use the district's zone"),
});
export const DistrictZoneBody = z.object({ zoneKey: z.string().max(40).nullable().describe('null: the default zone') });

export const BlockedContact = z
  .object({
    id: z.number().int(),
    kind: z.enum(['phone', 'ip']),
    value: z.string(),
    reason: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'BlockedContact' });
export const BlockedCreate = z.object({
  kind: z.enum(['phone', 'ip']),
  value: z.string().trim().min(3).max(64),
  reason: z.string().trim().min(3).max(200),
});

// ---------- Staff ----------

export const StaffMember = z
  .object({
    id: z.number().int(),
    email: z.string(),
    name: z.string(),
    role: AdminRole,
    active: z.boolean(),
    twoFactorSetUp: z.boolean(),
    lastLoginAt: z.string().nullable(),
    activeSessions: z.number().int(),
    createdAt: z.string(),
  })
  .meta({ id: 'StaffMember' });

export const StaffCreate = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(2).max(80),
  role: AdminRole,
});
export const StaffUpdate = z
  .object({ name: z.string().trim().min(2).max(80), role: AdminRole, active: z.boolean() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export const OneTimePassword = z
  .object({ member: StaffMember, password: z.string().describe('Shown once; hand it to the person') })
  .meta({ id: 'OneTimePassword' });
export const PasswordChange = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(12, 'Use at least 12 characters').max(200),
});

// ---------- Dashboard ----------

export const Dashboard = z
  .object({
    today: z.object({ orders: z.number().int(), revenue: Money }),
    month: z.object({ orders: z.number().int(), revenue: Money, averageOrder: Money }),
    byStatus: z.record(z.string(), z.number().int()),
    last30Days: z.array(z.object({ day: z.string(), orders: z.number().int(), revenue: Money })),
    topProducts: z.array(z.object({ name: z.string(), qty: z.number().int(), revenue: Money })),
    lowStock: z.array(
      z.object({
        sku: z.string(),
        productId: z.number().int(),
        name: z.string(),
        label: z.string(),
        stock: z.number().int(),
      }),
    ),
    lowStockThreshold: z.number().int(),
  })
  .meta({ id: 'Dashboard' });

// ---------- Audit log ----------

export const AuditQuery = z.object({
  adminId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(60).optional().describe('Exact action or prefix, e.g. "order." or "auth.login"'),
  entityType: z.string().trim().max(30).optional(),
  entityId: z.string().trim().max(60).optional(),
  from: Day.optional(),
  to: Day.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const AuditList = z
  .object({
    items: z.array(
      z.object({
        id: z.number().int(),
        at: z.string(),
        admin: z.string().nullable(),
        action: z.string(),
        entityType: z.string().nullable(),
        entityId: z.string().nullable(),
        data: z.unknown(),
        ip: z.string().nullable(),
      }),
    ),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
    admins: z
      .array(z.object({ id: z.number().int(), name: z.string() }))
      .describe('Everyone who appears in the log, for filters'),
  })
  .meta({ id: 'AuditList' });
