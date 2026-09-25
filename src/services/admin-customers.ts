import type { z } from 'zod';
import type { AdminUser, Prisma } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import type { CustomerQuery, CustomerUpdate } from '../schemas/admin-3c.js';

interface Context {
  admin: AdminUser;
  ip: string;
}

/** Orders, outcomes and spend per customer, for a set of customer ids. */
async function stats(db: Db, customerIds: number[]) {
  const rows = await db.order.groupBy({
    by: ['customerId', 'status'],
    where: { customerId: { in: customerIds } },
    _count: { _all: true },
    _sum: { total: true },
    _max: { createdAt: true },
  });
  const out = new Map<
    number,
    {
      orders: number;
      delivered: number;
      cancelled: number;
      returned: number;
      spent: number;
      lastOrderAt: string | null;
    }
  >();
  for (const id of customerIds)
    out.set(id, { orders: 0, delivered: 0, cancelled: 0, returned: 0, spent: 0, lastOrderAt: null });
  for (const r of rows) {
    const s = out.get(r.customerId)!;
    s.orders += r._count._all;
    if (r.status === 'delivered') {
      s.delivered += r._count._all;
      s.spent += r._sum.total ?? 0;
    }
    if (r.status === 'cancelled') s.cancelled += r._count._all;
    if (r.status === 'returned' || r.status === 'refunded') s.returned += r._count._all;
    const last = r._max.createdAt?.toISOString() ?? null;
    if (last && (!s.lastOrderAt || last > s.lastOrderAt)) s.lastOrderAt = last;
  }
  return out;
}

async function blockedPhones(db: Db, phones: string[]) {
  const rows = await db.blockedContact.findMany({ where: { kind: 'phone', value: { in: phones } } });
  return new Map(rows.map((r) => [r.value, r]));
}

export async function listCustomers(db: Db, q: z.infer<typeof CustomerQuery>) {
  const term = q.q?.trim();
  const blockedList =
    q.blocked === undefined
      ? null
      : (await db.blockedContact.findMany({ where: { kind: 'phone' } })).map((b) => b.value);
  const where: Prisma.CustomerWhereInput = {
    ...(term && {
      OR: [
        { phone: { contains: term.replace(/[\s-]/g, '').replace(/^\+?88(?=01)/, '') } },
        { name: { contains: term, mode: 'insensitive' } },
      ],
    }),
    ...(blockedList && (q.blocked ? { phone: { in: blockedList } } : { phone: { notIn: blockedList } })),
  };
  const [rows, total] = await Promise.all([
    db.customer.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    db.customer.count({ where }),
  ]);
  const [s, blocked] = await Promise.all([
    stats(
      db,
      rows.map((r) => r.id),
    ),
    blockedPhones(
      db,
      rows.map((r) => r.phone),
    ),
  ]);
  return {
    items: rows.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      blocked: blocked.has(c.phone),
      ...s.get(c.id)!,
    })),
    total,
    page: q.page,
    limit: q.limit,
  };
}

export async function getCustomer(db: Db, id: number) {
  const c = await db.customer.findUnique({ where: { id } });
  if (!c) throw new ApiError(404, 'NOT_FOUND', 'Customer not found.');
  const [s, blocked, recent] = await Promise.all([
    stats(db, [id]),
    db.blockedContact.findUnique({ where: { kind_value: { kind: 'phone', value: c.phone } } }),
    db.order.findMany({
      where: { customerId: id },
      orderBy: { id: 'desc' },
      take: 50,
      select: {
        orderNo: true,
        createdAt: true,
        total: true,
        status: true,
        source: true,
        items: { select: { qty: true } },
      },
    }),
  ]);
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    notes: c.notes,
    createdAt: c.createdAt.toISOString(),
    blocked: blocked ? { reason: blocked.reason, since: blocked.createdAt.toISOString() } : null,
    ...s.get(id)!,
    recentOrders: recent.map((o) => ({
      orderNo: o.orderNo,
      createdAt: o.createdAt.toISOString(),
      total: o.total,
      status: o.status,
      source: o.source,
      items: o.items.reduce((a, i) => a + i.qty, 0),
    })),
  };
}

export async function updateCustomer(db: Db, id: number, input: z.infer<typeof CustomerUpdate>, ctx: Context) {
  if (!(await db.customer.findUnique({ where: { id } }))) throw new ApiError(404, 'NOT_FOUND', 'Customer not found.');
  await db.customer.update({ where: { id }, data: input });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'customer.update',
    entityType: 'customer',
    entityId: id,
    ip: ctx.ip,
    data: { fields: Object.keys(input) },
  });
}

/** Stops the customer's phone number placing orders online (they can still order by phone). */
export async function setCustomerBlocked(db: Db, id: number, block: boolean, reason: string | null, ctx: Context) {
  const c = await db.customer.findUnique({ where: { id } });
  if (!c) throw new ApiError(404, 'NOT_FOUND', 'Customer not found.');
  if (block)
    await db.blockedContact.upsert({
      where: { kind_value: { kind: 'phone', value: c.phone } },
      create: { kind: 'phone', value: c.phone, reason },
      update: { reason },
    });
  else await db.blockedContact.deleteMany({ where: { kind: 'phone', value: c.phone } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: block ? 'customer.block' : 'customer.unblock',
    entityType: 'customer',
    entityId: id,
    ip: ctx.ip,
    data: { phone: c.phone, ...(reason && { reason }) },
  });
}
