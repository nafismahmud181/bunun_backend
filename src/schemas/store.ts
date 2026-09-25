import { z } from 'zod';

const Money = z.number().int().describe('Whole taka');

export const DeliveryZone = z
  .object({ key: z.string(), name: z.string(), fee: Money, estimate: z.string() })
  .meta({ id: 'DeliveryZone' });

export const PublicSettings = z
  .object({
    freeDeliveryThreshold: Money,
    hotline: z.string(),
    zones: z.array(DeliveryZone),
  })
  .meta({ id: 'StoreSettings' });

const Area = z.object({ id: z.number().int(), name: z.string(), nameBn: z.string().nullable(), zone: z.string() });
const District = z.object({
  id: z.number().int(),
  name: z.string(),
  nameBn: z.string().nullable(),
  areas: z.array(Area),
});

export const LocationTree = z
  .array(
    z.object({ id: z.number().int(), name: z.string(), nameBn: z.string().nullable(), districts: z.array(District) }),
  )
  .meta({ id: 'LocationTree' });
