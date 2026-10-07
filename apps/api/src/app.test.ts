import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from './app'
import { loadConfig } from './config'

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' })
const app = await buildApp(config)

beforeAll(() => app.ready())
afterAll(() => app.close())

describe('app', () => {
  it('reports health with a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', instance: config.instanceId })
    expect(res.headers['x-request-id']).toMatch(/^[\w-]+$/)
  })

  it('keeps a valid upstream request id', async () => {
    const res = await app.inject({ url: '/health', headers: { 'x-request-id': 'edge-123' } })
    expect(res.headers['x-request-id']).toBe('edge-123')
  })

  it('answers unknown routes with a typed 404', async () => {
    const res = await app.inject({ url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } })
  })

  it('sends security headers', async () => {
    const res = await app.inject({ url: '/health' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('only allows configured CORS origins', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    })
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173')

    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('config', () => {
  it('refuses to start in production with development defaults', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET[\s\S]*COOKIE_SECURE/)
  })

  it('parses the CORS allowlist', () => {
    const c = loadConfig({ CORS_ORIGINS: 'https://a.com, https://b.com' })
    expect(c.corsOrigins).toEqual(['https://a.com', 'https://b.com'])
  })
})
