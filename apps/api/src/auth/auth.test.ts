import { eq } from 'drizzle-orm'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import { sessionFrom, signUp, useTestApp, WEB_ORIGIN } from '../../test/app'
import { expectLedgerConsistent } from '../../test/db'
import { sessions, users } from '../db/schema'
import { SESSION_COOKIE } from './plugin'

const { app, db, config } = await useTestApp({ AUTH_RATE_LIMIT_PER_MINUTE: '5' })

const signIn = (email: string, password: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/auth/sign-in',
    headers: { origin: WEB_ORIGIN, ...headers },
    payload: { email, password },
  })

const getSession = (cookie?: string) =>
  app.inject({ url: '/auth/session', headers: cookie ? { cookie } : {} })

describe('sign-up', () => {
  it('creates the account, its wallet and a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      headers: { origin: WEB_ORIGIN },
      payload: {
        email: ' Ada@Example.com ',
        password: 'correct horse battery',
        displayName: 'Ada',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      user: { email: 'ada@example.com', displayName: 'Ada', role: 'user' },
      wallet: { available: 1_000, reserved: 0 },
    })

    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' })
    await expectLedgerConsistent(db)
  })

  it('stores an argon2id hash, never the password', async () => {
    await signUp(app, { email: 'hash@test.dev', password: 'my secret password' })
    const [user] = await db.select().from(users).where(eq(users.email, 'hash@test.dev'))
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/)
    expect(user?.passwordHash).not.toContain('my secret password')
  })

  it('rejects a taken email', async () => {
    await signUp(app, { email: 'taken@test.dev' })
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      headers: { origin: WEB_ORIGIN },
      payload: { email: 'TAKEN@test.dev', password: 'another password', displayName: 'Copy' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: { code: 'EMAIL_TAKEN' } })
  })

  it('validates the payload with field errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      headers: { origin: WEB_ORIGIN },
      payload: { email: 'not-an-email', password: 'short', displayName: '<script>' },
    })
    expect(res.statusCode).toBe(400)
    const { error } = res.json<{ error: { code: string; fields: Record<string, string> } }>()
    expect(error.code).toBe('VALIDATION')
    expect(Object.keys(error.fields).sort()).toEqual(['displayName', 'email', 'password'])
  })
})

describe('sign-in and sessions', () => {
  it('signs in and reads the session', async () => {
    await signUp(app, { email: 'grace@test.dev', password: 'hopper hopper' })
    const res = await signIn('grace@test.dev', 'hopper hopper')
    expect(res.statusCode).toBe(200)
    const session = sessionFrom(res)

    const me = await getSession(session.cookie)
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ user: { email: 'grace@test.dev' } })
  })

  it('gives the same answer for unknown emails and wrong passwords', async () => {
    await signUp(app, { email: 'real@test.dev', password: 'right password' })
    const wrong = await signIn('real@test.dev', 'wrong password')
    const unknown = await signIn('ghost@test.dev', 'whatever123')
    expect(wrong.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(wrong.json()).toEqual(unknown.json())
  })

  it('treats guests as guests', async () => {
    expect((await getSession()).statusCode).toBe(401)
  })

  it('revokes the session on sign-out, even if the cookie is replayed', async () => {
    const session = await signUp(app)
    const out = await app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      headers: session.headers,
    })
    expect(out.statusCode).toBe(204)
    expect((await getSession(session.cookie)).statusCode).toBe(401)
  })

  it('rejects forged, foreign-key and expired tokens', async () => {
    const session = await signUp(app)
    const [row] = await db.select().from(sessions)
    const claims = { sid: row!.id }
    const sign = (secret: string, exp: number) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(row!.userId)
        .setIssuer('bidrush')
        .setAudience('bidrush-session')
        .setExpirationTime(exp)
        .sign(new TextEncoder().encode(secret))

    const now = Math.floor(Date.now() / 1000)
    const forged = await sign('some-other-secret-some-other-secret!', now + 3600)
    const expired = await sign(config.jwtSecret, now - 10)
    const tampered = session.cookie.slice(0, -2) + 'xx'

    for (const token of [forged, expired]) {
      expect((await getSession(`${SESSION_COOKIE}=${token}`)).statusCode).toBe(401)
    }
    expect((await getSession(tampered)).statusCode).toBe(401)
  })
})

describe('CSRF and origin checks', () => {
  it('requires the CSRF token on state-changing requests', async () => {
    const session = await signUp(app)
    const noToken = await app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      headers: { cookie: session.cookie, origin: WEB_ORIGIN },
    })
    expect(noToken.statusCode).toBe(403)
    expect(noToken.json()).toMatchObject({ error: { code: 'CSRF' } })

    const other = await signUp(app)
    const wrongToken = await app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      headers: { ...session.headers, 'x-csrf-token': other.csrfToken },
    })
    expect(wrongToken.statusCode).toBe(403)

    // The session survived both attempts.
    expect((await getSession(session.cookie)).statusCode).toBe(200)
  })

  it('rejects state-changing requests from unknown origins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'x@test.dev', password: 'correct horse battery', displayName: 'X' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } })
  })
})

describe('brute-force protection', () => {
  it('rate-limits sign-in attempts per IP', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      statuses.push((await signIn(`nobody${i}@test.dev`, 'guess guess')).statusCode)
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(statuses.slice(5)).toEqual([429, 429])
  })

  it('does not trust a spoofed X-Forwarded-For from the client', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      // The attacker sends a fake IP each time; nginx appends the real one
      // (192.0.2.50). Only the hop added by our proxy is trusted.
      const res = await signIn(`spoof${i}@test.dev`, 'guess guess', {
        'x-forwarded-for': `203.0.113.${i}, 192.0.2.50`,
      })
      statuses.push(res.statusCode)
    }
    expect(statuses.slice(5)).toEqual([429, 429])
  })

  it('locks an email after repeated failures, across IPs', async () => {
    await signUp(app, { email: 'target@test.dev', password: 'the real password' })
    const fromIp = (i: number) => ({ 'x-forwarded-for': `198.51.100.${i}, 10.0.0.1` })
    for (let i = 0; i < 10; i++) {
      // Different IP each time (via the trusted proxy hop) to dodge the per-IP limit.
      await signIn('target@test.dev', `wrong ${i}`, fromIp(i))
    }
    const res = await signIn('target@test.dev', 'the real password', fromIp(99))
    expect(res.statusCode).toBe(429)
  })
})
