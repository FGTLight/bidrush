/** Builds the real app against the test Postgres and Redis. */
import type { SessionResponse } from '@bidrush/shared'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeEach, expect } from 'vitest'

import { buildApp } from '../src/app'
import { SESSION_COOKIE } from '../src/auth/plugin'
import { loadConfig } from '../src/config'
import { createRedis } from '../src/redis'
import { resetDb, useTestDb } from './db'
import { TEST_REDIS_URL } from './env'

export const WEB_ORIGIN = 'http://localhost:5173'

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: WEB_ORIGIN,
    SIGNUP_CREDITS: '1000',
    ...overrides,
  })
}

export async function useTestApp(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides)
  const { db } = useTestDb()
  const redis = createRedis(TEST_REDIS_URL)
  await redis.connect()
  const app = await buildApp({ config, db, redis: redis.redis })
  await app.ready()

  beforeEach(async () => {
    await resetDb(db)
    await redis.redis.flushdb()
  })
  afterAll(async () => {
    await app.close()
    await redis.close()
  })
  return { app, db, redis: redis.redis, config }
}

/** A signed-in browser: the session cookie plus the CSRF token. */
export interface TestSession {
  cookie: string
  csrfToken: string
  body: SessionResponse
  /** Headers for a state-changing request from the web app. */
  headers: Record<string, string>
}

export function sessionFrom(res: LightMyRequestResponse): TestSession {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)
  expect(cookie, 'session cookie set').toBeDefined()
  const body = res.json<SessionResponse>()
  const header = `${SESSION_COOKIE}=${cookie!.value}`
  return {
    cookie: header,
    csrfToken: body.csrfToken,
    body,
    headers: { cookie: header, 'x-csrf-token': body.csrfToken, origin: WEB_ORIGIN },
  }
}

let seq = 0

export async function signUp(
  app: Awaited<ReturnType<typeof useTestApp>>['app'],
  overrides: Partial<{ email: string; password: string; displayName: string }> = {},
) {
  seq += 1
  const res = await app.inject({
    method: 'POST',
    url: '/auth/sign-up',
    headers: { origin: WEB_ORIGIN },
    payload: {
      email: `bidder${seq}@test.dev`,
      password: 'correct horse battery',
      displayName: `Bidder ${seq}`,
      ...overrides,
    },
  })
  expect(res.statusCode, res.body).toBe(201)
  return sessionFrom(res)
}
