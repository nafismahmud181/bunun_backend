import type { z } from 'zod';
import { type VariantField, VariantFields, WEIGHT_FIELD } from '../schemas/admin-catalogue.js';

type Field = z.infer<typeof VariantField>;

/** Categories created before option fields existed record only the shipping weight. */
export const DEFAULT_FIELDS: Field[] = [{ key: WEIGHT_FIELD, label: 'Weight', unit: 'g' }];

/** A category's option fields; a stored value that no longer validates falls back to the default. */
export function categoryFields(value: unknown): Field[] {
  const parsed = VariantFields.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_FIELDS;
}
