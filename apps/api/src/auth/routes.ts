import { type SessionResponse, signInBody, signUpBody } from '@bidrush/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import type { Config } from '../config'
import type { Db, Executor } from '../db/client'
import { isUniqueViolation } from '../db/errors'
import { users } from '../db/schema'
import { HttpError } from '../errors'
import { getWallet, grantCredits, openAccounts } from '../ledger/ledger'
import type { Redis } from '../redis'
import { burnPasswordCheck, csrfTokenFor, hashPassword, verifyPassword } from './crypto'
import { authOf, clearSessionCookie, requireUser, setSessionCookie } from './plugin'
import { type AuthContext, createSession, revokeSession } from './sessions'

interface Deps {
  config: Config
  db: Db
  redis: Redis
}

/** Failed sign-ins per email before it is locked for the window. */
const MAX_FAILURES_PER_EMAIL = 10
const FAILURE_WINDOW_S = 15 * 60

async function sessionResponse(
  ex: Executor,
  config: Config,
  auth: Pick<AuthContext, 'userId' | 'sessionId' | 'role' | 'displayName' | 'email'>,
): Promise<SessionResponse> {
  return {
    user: { id: auth.userId, email: auth.email, displayName: auth.displayName, role: auth.role },
    wallet: await getWallet(ex, auth.userId),
    csrfToken: csrfTokenFor(config.jwtSecret, auth.sessionId),
  }
}

const clientInfo = (req: FastifyRequest) => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
})

export async function authRoutes(app: FastifyInstance, { config, db, redis }: Deps) {
  // Per-IP limit on the credential endpoints (stored in Redis, so it holds
  // across API instances).
  const rateLimit = {
    rateLimit: { max: config.auth.rateLimitPerMinute, timeWindow: '1 minute' },
  }

  app.post('/auth/sign-up', { config: rateLimit }, async (req, reply) => {
    const body = signUpBody.parse(req.body)
    const passwordHash = await hashPassword(body.password)

    const result = await db
      .transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ email: body.email, passwordHash, displayName: body.displayName })
          .returning()
        if (!user) throw new Error('user not created')
        await openAccounts(tx, user.id)
        if (config.auth.signupCredits > 0) {
          await grantCredits(tx, user.id, config.auth.signupCredits, 'Welcome bonus')
        }
        const session = await createSession(tx, {
          userId: user.id,
          ttlMs: config.auth.sessionTtlMs,
          secret: config.jwtSecret,
          ...clientInfo(req),
        })
        return { user, session }
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'users_email_key')) {
          throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists.')
        }
        throw error
      })

    setSessionCookie(config, reply, result.session.token, result.session.expiresAt)
    req.log.info({ userId: result.user.id }, 'user signed up')
    return reply.status(201).send(
      await sessionResponse(db, config, {
        userId: result.user.id,
        sessionId: result.session.sessionId,
        role: result.user.role,
        displayName: result.user.displayName,
        email: result.user.email,
      }),
    )
  })

  app.post('/auth/sign-in', { config: rateLimit }, async (req, reply) => {
    const body = signInBody.parse(req.body)

    // Per-email lockout stops slow, distributed guessing that the per-IP
    // limit alone would miss.
    const failureKey = `auth:failures:${body.email}`
    const failures = Number(await redis.get(failureKey))
    if (failures >= MAX_FAILURES_PER_EMAIL) {
      throw new HttpError(
        429,
        'RATE_LIMITED',
        'Too many failed attempts. Try again in a few minutes.',
      )
    }

    const [user] = await db.select().from(users).where(eq(users.email, body.email))
    const valid = user
      ? await verifyPassword(user.passwordHash, body.password)
      : await burnPasswordCheck(body.password).then(() => false)

    if (!user || !valid) {
      await redis.multi().incr(failureKey).expire(failureKey, FAILURE_WINDOW_S).exec()
      req.log.warn({ email: body.email }, 'failed sign-in')
      // Same answer for unknown emails and wrong passwords.
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Wrong email or password.')
    }

    await redis.del(failureKey)
    const session = await createSession(db, {
      userId: user.id,
      ttlMs: config.auth.sessionTtlMs,
      secret: config.jwtSecret,
      ...clientInfo(req),
    })
    setSessionCookie(config, reply, session.token, session.expiresAt)
    return sessionResponse(db, config, {
      userId: user.id,
      sessionId: session.sessionId,
      role: user.role,
      displayName: user.displayName,
      email: user.email,
    })
  })

  app.post('/auth/sign-out', async (req, reply) => {
    if (req.auth) await revokeSession(db, req.auth.sessionId)
    clearSessionCookie(config, reply)
    return reply.status(204).send()
  })

  app.get('/auth/session', { preHandler: requireUser }, async (req) =>
    sessionResponse(db, config, authOf(req)),
  )
}
