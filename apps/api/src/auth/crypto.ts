import { createHmac, timingSafeEqual } from 'node:crypto'

import { hash, verify } from '@node-rs/argon2'
import { jwtVerify, SignJWT } from 'jose'

// ---------------------------------------------------------------- passwords

/**
 * argon2id with the OWASP-recommended minimum (19 MiB, 2 passes).
 * `2` is `Algorithm.Argon2id`, a const enum that isolated modules can't import.
 */
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export const hashPassword = (password: string) => hash(password, ARGON2)

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false // malformed hash
  }
}

/**
 * Verified against when the email doesn't exist, so "unknown email" and
 * "wrong password" take the same time and can't be told apart.
 */
let dummyHash: Promise<string> | null = null
export async function burnPasswordCheck(password: string) {
  dummyHash ??= hashPassword('bidrush-timing-equalizer')
  await verifyPassword(await dummyHash, password)
}

// ---------------------------------------------------------------- session tokens

const ISSUER = 'bidrush'
const AUDIENCE = 'bidrush-session'

export interface SessionClaims {
  userId: string
  sessionId: string
}

const key = (secret: string) => new TextEncoder().encode(secret)

export function signSessionToken(secret: string, claims: SessionClaims, expiresAt: Date) {
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key(secret))
}

/** Returns the claims of a valid, unexpired token; null otherwise. */
export async function verifySessionToken(
  secret: string,
  token: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    })
    const sid = payload.sid
    if (typeof payload.sub !== 'string' || typeof sid !== 'string') return null
    return { userId: payload.sub, sessionId: sid }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- CSRF

/**
 * CSRF token bound to the session: HMAC(secret, session id). A page on
 * another origin can make the browser send the cookie, but can't read this
 * token, so it can't forge the `x-csrf-token` header.
 */
export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url')
}

export function isValidCsrfToken(secret: string, sessionId: string, token: unknown): boolean {
  if (typeof token !== 'string') return false
  const expected = Buffer.from(csrfTokenFor(secret, sessionId))
  const given = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
