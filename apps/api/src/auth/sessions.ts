import type { Role } from '@bidrush/shared'
import { and, eq, gt, isNull } from 'drizzle-orm'

import type { Executor } from '../db/client'
import { sessions, users } from '../db/schema'
import { signSessionToken, verifySessionToken } from './crypto'

/** Who is making a request, attached to every request and socket. */
export interface AuthContext {
  userId: string
  sessionId: string
  role: Role
  displayName: string
  email: string
  blocked: boolean
}

export async function createSession(
  ex: Executor,
  opts: { userId: string; ttlMs: number; secret: string; ip?: string; userAgent?: string },
) {
  const expiresAt = new Date(Date.now() + opts.ttlMs)
  const [session] = await ex
    .insert(sessions)
    .values({
      userId: opts.userId,
      expiresAt,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent?.slice(0, 512) ?? null,
    })
    .returning({ id: sessions.id })
  if (!session) throw new Error('session not created')
  const token = await signSessionToken(
    opts.secret,
    { userId: opts.userId, sessionId: session.id },
    expiresAt,
  )
  return { sessionId: session.id, token, expiresAt }
}

/**
 * Turns a cookie token into an AuthContext: the JWT must be valid AND its
 * session must still exist, unexpired and unrevoked. Shared by HTTP requests
 * and the WebSocket handshake.
 */
export async function resolveSession(
  ex: Executor,
  secret: string,
  token: string | undefined,
): Promise<AuthContext | null> {
  if (!token) return null
  const claims = await verifySessionToken(secret, token)
  if (!claims) return null

  const [row] = await ex
    .select({
      userId: users.id,
      role: users.role,
      displayName: users.displayName,
      email: users.email,
      blockedAt: users.blockedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, claims.sessionId),
        eq(sessions.userId, claims.userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
  if (!row) return null
  return {
    userId: row.userId,
    sessionId: claims.sessionId,
    role: row.role,
    displayName: row.displayName,
    email: row.email,
    blocked: row.blockedAt !== null,
  }
}

export async function revokeSession(ex: Executor, sessionId: string) {
  await ex
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
}
