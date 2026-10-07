import { randomUUID } from 'node:crypto'

import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import type { ApiError } from '@bidrush/shared'
import Fastify, { type FastifyServerOptions } from 'fastify'
import { ZodError } from 'zod'

import type { Config } from './config'

/** Thrown by handlers for expected failures (404, 409...). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.logLevel === 'silent') return false
  return {
    level: config.logLevel,
    base: { instance: config.instanceId },
    // Never log credentials or session cookies.
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    ...(config.env === 'development' && {
      transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } },
    }),
  }
}

/**
 * Builds the Fastify app without listening, so tests can drive it with
 * `app.inject()`. `server.ts` adds the network side.
 */
export async function buildApp(config: Config) {
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
    trustProxy: true,
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

  app.get('/health', async () => ({
    status: 'ok',
    instance: config.instanceId,
    uptimeMs: Date.now() - startedAt,
  }))

  return app
}
