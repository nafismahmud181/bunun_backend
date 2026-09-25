import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from './prisma.js';

export interface AuditEntry {
  adminId?: number | null;
  action: string;
  entityType?: string;
  entityId?: string | number;
  data?: Prisma.InputJsonValue;
  ip?: string;
}

/** Records an admin action. Pass the transaction client to record it atomically with the change. */
export function audit(db: Pick<Db, 'auditLog'> | Prisma.TransactionClient, e: AuditEntry) {
  return db.auditLog.create({
    data: {
      adminId: e.adminId ?? null,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId === undefined ? undefined : String(e.entityId),
      data: e.data,
      ip: e.ip,
    },
  });
}
