import { randomUUID } from 'node:crypto'

import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import type { ApiError } from '@bidrush/shared'
import { sql } from 'drizzle-orm'
import Fastify, { type FastifyServerOptions } from 'fastify'
import { ZodError } from 'zod'

import { registerAuth } from './auth/plugin'
import { authRoutes } from './auth/routes'
import type { Config } from './config'
import type { Db } from './db/client'
import { HttpError } from './errors'
import type { Redis } from './redis'

export { HttpError }

function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.logLevel === 'silent') return false
  return {
    level: config.logLevel,
    base: { instance: config.instanceId },
    // Never log credentials or session cookies.
    redact: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
    ],
    ...(config.env === 'development' && {
      transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } },
    }),
  }
}

/** Everything the app needs from the outside world, injected for tests. */
export interface AppDeps {
  config: Config
  db: Db
  redis: Redis
}

/**
 * Builds the Fastify app without listening, so tests can drive it with
 * `app.inject()`. `server.ts` adds the network side.
 */
export async function buildApp({ config, db, redis }: AppDeps) {
  const startedAt = Date.now()
  const app = Fastify({
    logger: loggerOptions(config),
    // Correlate logs per request; honour an upstream proxy's id.
    genReqId: (req) => {
      const header = req.headers['x-request-id']
      return typeof header === 'string' && /^[\w-]{1,64}$/.test(header) ? header : randomUUID()
    },
    requestIdLogLabel: 'requestId',
    bodyLimit: 64 * 1024,
    // Trust exactly the proxies in front of us (nginx): the client IP is the
    // address they saw, not whatever X-Forwarded-For the client claims.
    trustProxy: (_address: string, hop: number) => hop < config.trustProxyHops,
  })

  await app.register(helmet, {
    // The API only serves JSON; the web app sets its own CSP.
    contentSecurityPolicy: false,
  })
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  })
  await app.register(rateLimit, {
    // Opt-in per route; counters live in Redis so limits hold across instances.
    global: false,
    redis,
    nameSpace: 'ratelimit:',
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} s.`,
    }),
  })

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })

  app.setErrorHandler((error, req, reply) => {
    let status = 500
    let body: ApiError = { error: { code: 'INTERNAL', message: 'Something went wrong.' } }

    if (error instanceof ZodError) {
      status = 400
      body = {
        error: {
          code: 'VALIDATION',
          message: 'Some fields are invalid.',
          fields: Object.fromEntries(error.issues.map((i) => [i.path.join('.'), i.message])),
        },
      }
    } else if (error instanceof HttpError) {
      status = error.statusCode
      body = { error: { code: error.code, message: error.message } }
    } else if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      // Fastify's own errors (rate limit, payload too large, bad JSON...).
      const e = error as { statusCode: number; code?: string; message: string }
      if (e.statusCode < 500) {
        status = e.statusCode
        body = { error: { code: e.code ?? 'BAD_REQUEST', message: e.message } }
      }
    }

    if (status >= 500) req.log.error({ err: error }, 'request failed')
    return reply.status(status).send(body)
  })

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }),
  )

  // Liveness plus dependency checks; 503 takes the instance out of rotation.
  app.get('/health', async (_req, reply) => {
    const [postgres, redisStatus] = await Promise.all([
      db
        .execute(sql`select 1`)
        .then(() => 'up' as const)
        .catch(() => 'down' as const),
      redis
        .ping()
        .then(() => 'up' as const)
        .catch(() => 'down' as const),
    ])
    const ok = postgres === 'up' && redisStatus === 'up'
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      instance: config.instanceId,
      uptimeMs: Date.now() - startedAt,
      checks: { postgres, redis: redisStatus },
    })
  })

  await registerAuth(app, { config, db })
  await app.register(authRoutes, { config, db, redis })

  return app
}
