import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ApiError, ErrorBody } from '../../lib/errors.js';
import { bearerToken, requireAdmin } from '../../plugins/admin-auth.js';
import {
  AdminProfile,
  AuthHeaders,
  LoginBody,
  LoginResult,
  SessionResult,
  TwoFactorBody,
} from '../../schemas/admin.js';
import { adminView, login, logout, verifyTwoFactor } from '../../services/admin-auth.js';

export const adminAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  const ctx = (req: { ip: string; headers: Record<string, unknown> }) => ({
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  });

  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['admin'],
        summary: 'Step 1 of sign-in: email and password',
        body: LoginBody,
        response: { 200: LoginResult, 401: ErrorBody, 403: ErrorBody, 423: ErrorBody },
      },
    },
    async (req) => login(app.db, app.config.ADMIN_ENCRYPTION_KEY, req.body.email, req.body.password, ctx(req)),
  );

  app.post(
    '/auth/2fa',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['admin'],
        summary: 'Step 2 of sign-in: the authenticator code (also completes two-factor setup)',
        headers: AuthHeaders,
        body: TwoFactorBody,
        response: { 200: SessionResult, 401: ErrorBody },
      },
    },
    async (req) => {
      const token = bearerToken(req);
      if (!token) throw new ApiError(401, 'SESSION_EXPIRED', 'Please sign in again.');
      return verifyTwoFactor(app.db, app.config.ADMIN_ENCRYPTION_KEY, token, req.body.code, ctx(req));
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: requireAdmin(),
      schema: {
        tags: ['admin'],
        summary: 'The signed-in admin',
        headers: AuthHeaders,
        response: { 200: AdminProfile, 401: ErrorBody },
      },
    },
    async (req) => adminView(req.admin!),
  );

  app.post(
    '/auth/logout',
    { schema: { tags: ['admin'], summary: 'End the session (responds 204)', headers: AuthHeaders } },
    async (req, reply) => {
      const token = bearerToken(req);
      if (token) await logout(app.db, token);
      return reply.code(204).send();
    },
  );
};
