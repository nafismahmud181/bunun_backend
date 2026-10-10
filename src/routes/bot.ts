import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, ErrorBody } from '../lib/errors.js';
import { auditTelegram, linkTelegram, telegramSession, unlinkTelegram } from '../services/telegram-bot.js';

// Called only by the Telegram deploy bot (bunun_deploybot), which sends BOT_API_SECRET in the
// X-Bot-Secret header. Switched off (404) while BOT_API_SECRET isn't set. Left out of the API docs.
const TelegramUser = z.object({ telegramUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const Owner = z.object({ name: z.string(), email: z.string() });

const digest = (s: string) => createHash('sha256').update(s).digest();

export const botRoutes: FastifyPluginAsyncZod = async (app) => {
  const secret = app.config.BOT_API_SECRET;
  app.addHook('onRequest', async (req) => {
    if (!secret) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    const sent = req.headers['x-bot-secret'];
    if (typeof sent !== 'string' || !timingSafeEqual(digest(sent), digest(secret)))
      throw new ApiError(401, 'BAD_BOT_SECRET', 'Not allowed.');
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 423: ErrorBody };
  const ctx = (req: { ip: string }) => ({ ip: req.ip });

  app.post(
    '/bot/link',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        hide: true,
        body: TelegramUser.extend({
          email: z.string().trim().max(200),
          password: z.string().min(1).max(200),
          code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
        }),
        response: { 200: Owner, ...errors },
      },
    },
    async (req) => linkTelegram(app.db, app.config.ADMIN_ENCRYPTION_KEY, req.body, ctx(req)),
  );

  app.post(
    '/bot/session',
    {
      schema: {
        hide: true,
        body: TelegramUser,
        response: { 200: z.object({ owner: Owner.nullable() }), ...errors },
      },
    },
    async (req) => {
      const s = await telegramSession(app.db, req.body.telegramUserId);
      return { owner: s ? { name: s.name, email: s.email } : null };
    },
  );

  app.post(
    '/bot/unlink',
    { schema: { hide: true, body: TelegramUser, response: { 204: z.null(), ...errors } } },
    async (req, reply) => {
      await unlinkTelegram(app.db, req.body.telegramUserId, req.ip);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/bot/audit',
    {
      schema: {
        hide: true,
        body: TelegramUser.extend({
          action: z.enum(['deploy', 'restart']),
          app: z.string().max(40),
          result: z.string().max(200),
        }),
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      const { telegramUserId, ...entry } = req.body;
      await auditTelegram(app.db, telegramUserId, entry, req.ip);
      return reply.code(204).send(null);
    },
  );
};
