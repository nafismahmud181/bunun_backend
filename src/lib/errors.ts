import { z } from 'zod';

/**
 * An error with an HTTP status and a stable machine-readable `code` the storefront can act on
 * (e.g. OUT_OF_STOCK). Thrown from services; app.ts turns it into the JSON body below.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const ErrorBody = z
  .object({
    statusCode: z.number().int(),
    error: z.string(),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'Error' });
