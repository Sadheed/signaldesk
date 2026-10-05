import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import type { Config } from '../config.ts';
import type { Actor, EventBus, Store } from '../domain/types.ts';
import type { Logger } from '../logger.ts';
import { AppError, parseCursor, requireAdmin } from '../domain/errors.ts';
import { AuthService } from '../services/auth.ts';
import { EventService } from '../services/events.ts';
import { Throttle } from './throttle.ts';
import {
  eventSchema,
  loginSchema,
  memberSchema,
  readSchema,
  registrationSchema,
  uuidSchema,
} from './validation.ts';

export interface StreamEndpoint {
  open(request: Request, response: Response, actor: Actor, token: string, cursor: string): void;
}
interface Dependencies {
  store: Store;
  bus: EventBus;
  config: Config;
  logger: Logger;
  stream?: StreamEndpoint;
}
export function sessionToken(request: Request): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('sd_session='))
    ?.slice('sd_session='.length);
}
export function createApp({ store, bus, config, logger, stream }: Dependencies) {
  const app = express();
  app.disable('x-powered-by');
  const auth = new AuthService(store, config.SESSION_TTL_HOURS);
  const events = new EventService(store, bus, logger);
  const throttle = new Throttle();
  const secureCookie = config.NODE_ENV === 'production';
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: 'strict' as const,
    path: '/',
  };

  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set({
      'X-Request-Id': res.locals.requestId,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    const start = performance.now();
    res.once('finish', () =>
      logger.info('http_request', {
        requestId: res.locals.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - start),
      }),
    );
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== config.APP_ORIGIN
    )
      return next(new AppError(403, 'INVALID_ORIGIN', 'Cross-origin mutations are refused'));
    next();
  });
  app.get('/health/live', (_req, res) => res.json({ status: 'alive' }));
  app.get('/health/ready', async (_req, res) => {
    const database = await store.healthy();
    const redis = bus.healthy();
    res
      .status(database && redis ? 200 : 503)
      .json({ status: database && redis ? 'ready' : 'degraded', database, redis });
  });
  const authLimit = (req: Request, _res: Response, next: NextFunction) => {
    try {
      throttle.check(req.socket.remoteAddress ?? 'unknown');
      next();
    } catch (error) {
      next(error);
    }
  };
  const setSession = (res: Response, token: string) =>
    res.cookie('sd_session', token, {
      ...cookieOptions,
      maxAge: config.SESSION_TTL_HOURS * 3600000,
    });
  app.post('/api/auth/register', authLimit, async (req, res) => {
    const result = await auth.register(registrationSchema.parse(req.body));
    setSession(res, result.token);
    res.status(201).json(result.actor);
  });
  app.post('/api/auth/login', authLimit, async (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = await auth.login(input.email, input.password);
    setSession(res, result.token);
    res.json(result.actor);
  });
  app.post('/api/auth/logout', async (req, res) => {
    await auth.logout(sessionToken(req));
    res.clearCookie('sd_session', cookieOptions);
    res.status(204).end();
  });
  app.use('/api', async (req, res, next) => {
    res.locals.actor = await auth.authenticate(sessionToken(req));
    next();
  });
  const actor = (res: Response): Actor => res.locals.actor as Actor;
  app.get('/api/me', (_req, res) => res.json(actor(res)));
  app.get('/api/members', async (_req, res) => res.json(await store.members(actor(res))));
  app.post('/api/members', authLimit, async (req, res) => {
    requireAdmin(actor(res).role);
    res.status(201).json(await auth.addMember(actor(res), memberSchema.parse(req.body)));
  });
  app.get('/api/events', async (req, res) => {
    const before = req.query.before === undefined ? undefined : parseCursor(req.query.before);
    const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || Array.isArray(req.query.limit))
      throw new AppError(400, 'INVALID_LIMIT', 'Limit must be an integer between 1 and 100');
    res.json(await store.history(actor(res), before, limit));
  });
  app.post('/api/events', async (req, res) => {
    requireAdmin(actor(res).role);
    res.status(201).json(await events.create(actor(res), eventSchema.parse(req.body)));
  });
  app.put('/api/events/:id/read', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const { read } = readSchema.parse(req.body);
    if (!(await store.markRead(actor(res), id, read)))
      throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');
    res.status(204).end();
  });
  app.get('/api/events/stream', (req, res) => {
    if (!stream) throw new AppError(503, 'STREAM_UNAVAILABLE', 'Live stream unavailable');
    // Native EventSource sends Last-Event-ID on reconnect; it supersedes the original URL cursor.
    const cursor = parseCursor(req.headers['last-event-id'] ?? req.query.after ?? '0');
    stream.open(req, res, actor(res), sessionToken(req)!, cursor);
  });
  app.use('/api', (_req, _res, next) =>
    next(new AppError(404, 'NOT_FOUND', 'API endpoint not found')),
  );
  const assets = fileURLToPath(new URL('../../dist/', import.meta.url));
  if (existsSync(assets)) {
    app.use(express.static(assets));
    app.get('/{*path}', (_req, res) => res.sendFile(`${assets}/index.html`));
  }
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId: string = res.locals.requestId;
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof ZodError) {
      res
        .status(400)
        .json({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Invalid input',
            fields: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
            requestId,
          },
        });
      return;
    }
    if (error instanceof AppError) {
      if (error.status === 429) res.set('Retry-After', '900');
      res
        .status(error.status)
        .json({ error: { code: error.code, message: error.message, requestId } });
      return;
    }
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
    if (code === '23505') {
      res
        .status(409)
        .json({
          error: {
            code: 'ALREADY_EXISTS',
            message: 'An account with that email already exists',
            requestId,
          },
        });
      return;
    }
    const status =
      typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
    if (status === 400 || status === 413) {
      res
        .status(status)
        .json({
          error: {
            code: 'INVALID_BODY',
            message: status === 413 ? 'Request body too large' : 'Malformed JSON',
            requestId,
          },
        });
      return;
    }
    logger.error('request_failed', { requestId });
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error', requestId } });
  });
  return app;
}
