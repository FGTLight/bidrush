import { randomUUID } from 'node:crypto'

import type { Redis } from '../redis'

/** Deletes the key only if we still own it (another holder may have taken over after expiry). */
const RELEASE = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`

/**
 * Runs `fn` while holding a Redis lock, or returns `{ acquired: false }`
 * when another instance holds it. The lock expires after `ttlMs` so a
 * crashed holder can't block forever.
 *
 * This is a fence against duplicate *work*, not the correctness guarantee:
 * callers must still be safe if it fails (they are: Postgres decides).
 */
export async function withLock<T>(
  redis: Redis,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const token = randomUUID()
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX')
  if (ok !== 'OK') return { acquired: false }
  try {
    return { acquired: true, value: await fn() }
  } finally {
    await redis.eval(RELEASE, 1, key, token).catch(() => undefined)
  }
}
