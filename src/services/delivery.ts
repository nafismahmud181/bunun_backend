import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';

/** Zone for areas that don't set one and whose district doesn't either. */
export const DEFAULT_ZONE = 'outside-dhaka';

type Tx = Pick<Db, 'area' | 'deliveryZone'>;

/** An area with its district, division and resolved delivery zone. Throws 400 for an unknown area. */
export async function resolveArea(db: Tx, areaId: number) {
  const area = await db.area.findUnique({
    where: { id: areaId },
    include: { district: { include: { division: true } } },
  });
  if (!area) throw new ApiError(400, 'UNKNOWN_AREA', 'Please choose your area from the list.');
  const zoneKey = area.zoneKey ?? area.district.zoneKey ?? DEFAULT_ZONE;
  const zone = await db.deliveryZone.findUnique({ where: { key: zoneKey } });
  if (!zone) throw new Error(`Delivery zone "${zoneKey}" is not configured`);
  return { area, district: area.district, division: area.district.division, zone };
}

/** Delivery fee for a subtotal: free at or above the threshold (and for an empty cart). */
export function deliveryFee(subtotal: number, zoneFee: number, freeThreshold: number) {
  return subtotal === 0 || subtotal >= freeThreshold ? 0 : zoneFee;
}

/** The whole location tree for the address picker, with each area's delivery zone resolved. */
export async function locationTree(db: Pick<Db, 'division'>) {
  const divisions = await db.division.findMany({
    orderBy: { nameEn: 'asc' },
    include: {
      districts: {
        orderBy: { nameEn: 'asc' },
        include: { areas: { orderBy: [{ sort: 'asc' }, { nameEn: 'asc' }] } },
      },
    },
  });
  return divisions.map((dv) => ({
    id: dv.id,
    name: dv.nameEn,
    nameBn: dv.nameBn,
    districts: dv.districts.map((ds) => ({
      id: ds.id,
      name: ds.nameEn,
      nameBn: ds.nameBn,
      areas: ds.areas.map((a) => ({
        id: a.id,
        name: a.nameEn,
        nameBn: a.nameBn,
        zone: a.zoneKey ?? ds.zoneKey ?? DEFAULT_ZONE,
      })),
    })),
  }));
}
