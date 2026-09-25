import type { z } from 'zod';
import type { AdminUser, Prisma } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import { getSettings } from '../lib/settings.js';
import type { AreaZoneBody, BlockedCreate, SettingsUpdate, ZoneCreate, ZoneUpdate } from '../schemas/admin-3c.js';
import { DEFAULT_ZONE } from './delivery.js';

interface Context {
  admin: AdminUser;
  ip: string;
}

export async function updateSettings(db: Db, input: z.infer<typeof SettingsUpdate>, ctx: Context) {
  const before = await getSettings(db);
  await db.$transaction(
    Object.entries(input).map(([key, value]) =>
      db.setting.upsert({
        where: { key },
        create: { key, value: value as Prisma.InputJsonValue },
        update: { value: value as Prisma.InputJsonValue },
      }),
    ),
  );
  const changed = Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]),
  );
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'settings.update',
    entityType: 'settings',
    ip: ctx.ip,
    data: changed as Prisma.InputJsonValue,
  });
  return getSettings(db);
}

export async function listZones(db: Db) {
  const [zones, areas, districts] = await Promise.all([
    db.deliveryZone.findMany({ orderBy: [{ sort: 'asc' }, { key: 'asc' }] }),
    db.area.groupBy({ by: ['zoneKey'], _count: { _all: true } }),
    db.district.groupBy({ by: ['zoneKey'], _count: { _all: true } }),
  ]);
  return zones.map((z) => ({
    ...z,
    areas: areas.find((a) => a.zoneKey === z.key)?._count._all ?? 0,
    districts: districts.find((d) => d.zoneKey === z.key)?._count._all ?? 0,
  }));
}

export async function createZone(db: Db, input: z.infer<typeof ZoneCreate>, ctx: Context) {
  if (await db.deliveryZone.findUnique({ where: { key: input.key } }))
    throw new ApiError(409, 'KEY_TAKEN', 'A zone with that key already exists.');
  const last = await db.deliveryZone.aggregate({ _max: { sort: true } });
  await db.deliveryZone.create({ data: { ...input, sort: (last._max.sort ?? -1) + 1 } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'zone.create',
    entityType: 'zone',
    entityId: input.key,
    ip: ctx.ip,
    data: input,
  });
}

export async function updateZone(db: Db, key: string, input: z.infer<typeof ZoneUpdate>, ctx: Context) {
  const before = await db.deliveryZone.findUnique({ where: { key } });
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Zone not found.');
  await db.deliveryZone.update({ where: { key }, data: input });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'zone.update',
    entityType: 'zone',
    entityId: key,
    ip: ctx.ip,
    data: { before: { fee: before.fee, name: before.name, estimate: before.estimate }, after: input },
  });
}

export async function deleteZone(db: Db, key: string, ctx: Context) {
  if (key === DEFAULT_ZONE)
    throw new ApiError(
      409,
      'DEFAULT_ZONE',
      "The default zone (outside Dhaka) is used for every area without a zone and can't be deleted.",
    );
  const [areas, districts] = await Promise.all([
    db.area.count({ where: { zoneKey: key } }),
    db.district.count({ where: { zoneKey: key } }),
  ]);
  if (areas || districts)
    throw new ApiError(
      409,
      'ZONE_IN_USE',
      `Move its ${areas} area(s) and ${districts} district(s) to another zone first.`,
    );
  const { count } = await db.deliveryZone.deleteMany({ where: { key } });
  if (!count) throw new ApiError(404, 'NOT_FOUND', 'Zone not found.');
  await audit(db, { adminId: ctx.admin.id, action: 'zone.delete', entityType: 'zone', entityId: key, ip: ctx.ip });
}

async function requireZone(db: Db, key: string | null) {
  if (key !== null && !(await db.deliveryZone.findUnique({ where: { key } })))
    throw new ApiError(400, 'UNKNOWN_ZONE', 'Unknown delivery zone.');
}

/** Puts areas into a zone (or back to their district's zone with null). */
export async function setAreaZone(db: Db, input: z.infer<typeof AreaZoneBody>, ctx: Context) {
  await requireZone(db, input.zoneKey);
  const { count } = await db.area.updateMany({
    where: { id: { in: input.areaIds } },
    data: { zoneKey: input.zoneKey },
  });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'zone.assign_areas',
    entityType: 'zone',
    entityId: input.zoneKey ?? 'district',
    ip: ctx.ip,
    data: { areaIds: input.areaIds },
  });
  return count;
}

export async function setDistrictZone(db: Db, districtId: number, zoneKey: string | null, ctx: Context) {
  await requireZone(db, zoneKey);
  const { count } = await db.district.updateMany({ where: { id: districtId }, data: { zoneKey } });
  if (!count) throw new ApiError(404, 'NOT_FOUND', 'District not found.');
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'zone.assign_district',
    entityType: 'zone',
    entityId: zoneKey ?? 'default',
    ip: ctx.ip,
    data: { districtId },
  });
}

export async function listBlocked(db: Db) {
  const rows = await db.blockedContact.findMany({ orderBy: { id: 'desc' } });
  return rows.map((b) => ({
    id: b.id,
    kind: b.kind as 'phone' | 'ip',
    value: b.value,
    reason: b.reason,
    createdAt: b.createdAt.toISOString(),
  }));
}

export async function addBlocked(db: Db, input: z.infer<typeof BlockedCreate>, ctx: Context) {
  let value = input.value.trim();
  if (input.kind === 'phone') {
    value = value.replace(/[\s-]/g, '').replace(/^\+?88(?=01)/, '');
    if (!/^01[3-9]\d{8}$/.test(value)) throw new ApiError(400, 'BAD_PHONE', 'Enter an 11-digit mobile number.');
  } else if (!/^[0-9a-fA-F:.]{3,45}$/.test(value)) throw new ApiError(400, 'BAD_IP', 'Enter an IP address.');
  await db.blockedContact.upsert({
    where: { kind_value: { kind: input.kind, value } },
    create: { kind: input.kind, value, reason: input.reason },
    update: { reason: input.reason },
  });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'blocked.add',
    entityType: 'blocked',
    entityId: `${input.kind}:${value}`,
    ip: ctx.ip,
    data: { reason: input.reason },
  });
}

export async function removeBlocked(db: Db, id: number, ctx: Context) {
  const b = await db.blockedContact.findUnique({ where: { id } });
  if (!b) throw new ApiError(404, 'NOT_FOUND', 'Not on the block list.');
  await db.blockedContact.delete({ where: { id } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'blocked.remove',
    entityType: 'blocked',
    entityId: `${b.kind}:${b.value}`,
    ip: ctx.ip,
  });
}
