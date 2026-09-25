import { z } from 'zod';
import { PERMISSIONS } from '../lib/permissions.js';

export const AdminRole = z.enum(['owner', 'manager', 'order_handler', 'content_editor']).meta({ id: 'AdminRole' });

export const AdminProfile = z
  .object({
    id: z.number().int(),
    email: z.string(),
    name: z.string(),
    role: AdminRole,
    permissions: z.array(z.enum(PERMISSIONS)),
  })
  .meta({ id: 'AdminProfile' });

export const LoginBody = z.object({
  email: z.string().trim().max(200),
  password: z.string().min(1).max(200),
});

export const LoginResult = z
  .object({
    stage: z.enum(['two_factor', 'two_factor_setup']),
    token: z.string().describe('Short-lived; send it as a Bearer token to POST /admin/auth/2fa'),
    expiresAt: z.string(),
    setup: z
      .object({ secret: z.string(), otpauthUrl: z.string() })
      .optional()
      .describe('Present when two-factor authentication must be set up: show as a QR code'),
  })
  .meta({ id: 'AdminLoginResult' });

export const TwoFactorBody = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export const SessionResult = z
  .object({ token: z.string(), expiresAt: z.string(), admin: AdminProfile })
  .meta({ id: 'AdminSession' });

// Optional here so a missing token gets 401 from requireAdmin(), not a 400 validation error.
export const AuthHeaders = z.looseObject({ authorization: z.string().max(200).optional() });
