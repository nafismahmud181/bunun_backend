import type { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../lib/prisma.js';
import type { AuditQuery } from '../schemas/admin-3c.js';

const dhakaDay = (day: string, plusDays = 0) => {
  const d = new Date(`${day}T00:00:00+06:00`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d;
};

export async function listAudit(db: Db, q: z.infer<typeof AuditQuery>) {
  const where: Prisma.AuditLogWhereInput = {
    ...(q.adminId && { adminId: q.adminId }),
    // "order." matches every order action; "auth.login" matches just that one.
    ...(q.action && (q.action.endsWith('.') ? { action: { startsWith: q.action } } : { action: q.action })),
    ...(q.entityType && { entityType: q.entityType }),
    ...(q.entityId && { entityId: q.entityId }),
    ...((q.from || q.to) && {
      createdAt: { ...(q.from && { gte: dhakaDay(q.from) }), ...(q.to && { lt: dhakaDay(q.to, 1) }) },
    }),
  };
  const [rows, total, adminIds] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { admin: { select: { name: true } } },
    }),
    db.auditLog.count({ where }),
    db.auditLog.findMany({ where: { adminId: { not: null } }, distinct: ['adminId'], select: { adminId: true } }),
  ]);
  const admins = await db.adminUser.findMany({
    where: { id: { in: adminIds.map((a) => a.adminId!) } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      admin: r.admin?.name ?? null,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      data: r.data,
      ip: r.ip,
    })),
    total,
    page: q.page,
    limit: q.limit,
    admins,
  };
}
