import { apiErrorSchema } from '@bidrush/shared'
import type { z } from 'zod'

/** Same origin by default (Vite proxy / nginx); a full URL when deployed apart. */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api'

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message)
  }
}

let csrfToken: string | null = null
/** Set from the session response; sent on every mutating request. */
export const setCsrfToken = (token: string | null) => {
  csrfToken = token
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Validates the response, so the UI never renders unexpected shapes. */
  schema: z.ZodType<T>
  signal?: AbortSignal
}

export async function request<T>(path: string, options: RequestOptions<T>): Promise<T> {
  const { method = 'GET', body, schema, signal } = options
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
    credentials: 'include',
    signal: signal ?? null,
  })

  const json: unknown = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(json)
    if (parsed.success) {
      const { code, message, fields } = parsed.data.error
      throw new ApiRequestError(res.status, code, message, fields)
    }
    throw new ApiRequestError(res.status, 'HTTP_ERROR', `Request failed (${res.status})`)
  }
  return schema.parse(json)
}
