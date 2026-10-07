import cookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { HttpError } from '../errors'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { isValidCsrfToken } from './crypto'
import { type AuthContext, resolveSession } from './sessions'

export const SESSION_COOKIE = 'bidrush_session'

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, or null for guests. */
    auth: AuthContext | null
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Origins allowed to send cookie-authenticated, state-changing requests. */
export function isAllowedOrigin(config: Config, origin: string | undefined): boolean {
  return origin === undefined || config.corsOrigins.includes(origin)
}

export async function registerAuth(
  app: FastifyInstance,
  { config, db }: { config: Config; db: Db },
) {
  await app.register(cookie)
  app.decorateRequest('auth', null)

  app.addHook('onRequest', async (req) => {
    req.auth = await resolveSession(db, config.jwtSecret, req.cookies[SESSION_COOKIE])
  })

  // CSRF defence in depth for every state-changing request:
  // 1. Browsers always send Origin on cross-site POSTs: reject unknown ones.
  // 2. With a session cookie, also require the session-bound CSRF token.
  //    (Requests without Origin, e.g. scripts, have no ambient cookies to abuse
  //    unless they hold the token too.)
  app.addHook('preHandler', async (req) => {
    if (SAFE_METHODS.has(req.method)) return
    if (!isAllowedOrigin(config, req.headers.origin)) {
      throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'Requests from this origin are not allowed.')
    }
    if (
      req.auth &&
      !isValidCsrfToken(config.jwtSecret, req.auth.sessionId, req.headers['x-csrf-token'])
    ) {
      throw new HttpError(403, 'CSRF', 'Missing or invalid CSRF token. Reload the page.')
    }
  })
}

export function setSessionCookie(
  config: Config,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookie.secure,
    // Lax keeps the cookie off cross-site subrequests; None is only needed
    // when the web app is hosted on another site (and requires Secure).
    sameSite: config.cookie.crossSite ? 'none' : 'lax',
    path: '/',
    expires: expiresAt,
  })
}

export function clearSessionCookie(config: Config, reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    secure: config.cookie.secure,
    sameSite: config.cookie.crossSite ? 'none' : 'lax',
  })
}

/** preHandler: 401 for guests. */
export async function requireUser(req: FastifyRequest) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in to continue.')
}

/** preHandler: 403 for non-admins. */
export async function requireAdmin(req: FastifyRequest) {
  await requireUser(req)
  if (req.auth?.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Admins only.')
}

/** The signed-in user; call only behind `requireUser`. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in to continue.')
  return req.auth
}
