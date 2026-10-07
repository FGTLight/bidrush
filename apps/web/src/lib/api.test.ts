import { z } from 'zod'

import { ApiRequestError, request, setCsrfToken } from './api'

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

describe('request', () => {
  it('validates the response with the schema', async () => {
    mockFetch(200, { ok: true })
    await expect(request('/x', { schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({
      ok: true,
    })
  })

  it('rejects unexpected response shapes', async () => {
    mockFetch(200, { ok: 'yes' })
    await expect(request('/x', { schema: z.object({ ok: z.boolean() }) })).rejects.toThrow()
  })

  it('turns API errors into typed errors', async () => {
    mockFetch(409, { error: { code: 'EMAIL_TAKEN', message: 'Email in use' } })
    const error = await request('/x', { schema: z.unknown() }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' })
  })

  it('sends cookies, and the CSRF token on mutations only', async () => {
    const fetchMock = mockFetch(200, {})
    setCsrfToken('tok')
    await request('/x', { schema: z.unknown() })
    await request('/x', { method: 'POST', body: {}, schema: z.unknown() })

    const [, get] = fetchMock.mock.calls[0]!
    const [, post] = fetchMock.mock.calls[1]!
    expect(get?.credentials).toBe('include')
    expect(get?.headers).not.toHaveProperty('x-csrf-token')
    expect(post?.headers).toHaveProperty('x-csrf-token', 'tok')
  })
})
