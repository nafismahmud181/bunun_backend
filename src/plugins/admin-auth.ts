import type { FastifyRequest } from 'fastify';
import type { AdminUser } from '../generated/prisma/client.js';
import { ApiError } from '../lib/errors.js';
import { can, type Permission } from '../lib/permissions.js';
import { authenticate } from '../services/admin-auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAdmin() on admin routes. */
    admin: AdminUser | null;
  }
}

export const bearerToken = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

/**
 * preHandler for admin routes: requires a signed-in admin (Authorization: Bearer <session token>)
 * and, if given, a permission. Sets request.admin.
 */
export function requireAdmin(permission?: Permission) {
  return async (req: FastifyRequest) => {
    const token = bearerToken(req);
    const admin = token ? await authenticate(req.server.db, token) : null;
    if (!admin) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.');
    if (permission && !can(admin.role, permission))
      throw new ApiError(403, 'FORBIDDEN', "Your role doesn't allow this.");
    req.admin = admin;
  };
}
