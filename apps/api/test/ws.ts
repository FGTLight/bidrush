/** A real API instance on a random port, and a WebSocket client for tests. */
import type { ServerMessage } from '@bidrush/shared'
import { afterAll, afterEach } from 'vitest'
import WebSocket from 'ws'

import { buildApp } from '../src/app'
import type { Db } from '../src/db/client'
import { frameToString } from '../src/realtime/frames'
import { createRedis } from '../src/redis'
import { testConfig, WEB_ORIGIN } from './app'
import { TEST_REDIS_URL } from './env'

/** Starts an instance sharing the test database and Redis. */
export async function startInstance(
  db: Db,
  instanceId: string,
  overrides: Record<string, string> = {},
) {
  const redis = createRedis(TEST_REDIS_URL)
  await redis.connect()
  // Many sign-ups from 127.0.0.1 in one file: lift the per-IP auth limit.
  const config = testConfig({
    INSTANCE_ID: instanceId,
    AUTH_RATE_LIMIT_PER_MINUTE: '10000',
    // Transport tests opt out; the anti-bot tests opt in.
    ANTIBOT_MODE: 'off',
    ...overrides,
  })
  const app = await buildApp({ config, db, redis: redis.redis })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  afterAll(async () => {
    await app.close()
    await redis.close()
  })
  return { app, redis: redis.redis, wsUrl: `ws://127.0.0.1:${address.port}/ws` }
}

type Predicate = (m: ServerMessage) => boolean

const openSockets = new Set<WebSocket>()
afterEach(() => {
  for (const ws of openSockets) ws.close()
  openSockets.clear()
})

export class TestSocket {
  readonly messages: ServerMessage[] = []
  private waiters: { predicate: Predicate; resolve: (m: ServerMessage) => void }[] = []

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(frameToString(data)) as ServerMessage
      this.messages.push(message)
      this.waiters = this.waiters.filter((w) => {
        if (!w.predicate(message)) return true
        w.resolve(message)
        return false
      })
    })
  }

  static async connect(
    url: string,
    { cookie, origin = WEB_ORIGIN }: { cookie?: string; origin?: string | null } = {},
  ) {
    const headers: Record<string, string> = {}
    if (cookie) headers.cookie = cookie
    if (origin) headers.origin = origin
    const ws = new WebSocket(url, { headers })
    const socket = new TestSocket(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`handshake rejected: ${res.statusCode}`))
      })
    })
    openSockets.add(ws)
    return socket
  }

  send(message: unknown) {
    this.ws.send(JSON.stringify(message))
  }

  /** Position in the message log; pass to `next` to ignore older messages. */
  mark() {
    return this.messages.length
  }

  /**
   * Resolves with the first matching message, already received (from
   * position `since`) or future.
   */
  next<T extends ServerMessage['type']>(
    type: T,
    where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 5_000,
    since = 0,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const predicate = (m: ServerMessage) =>
      m.type === type && where(m as Extract<ServerMessage, { type: T }>)
    const seen = this.messages.slice(since).find(predicate)
    if (seen) return Promise.resolve(seen as Extract<ServerMessage, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${type}`))
      }, timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m as Extract<ServerMessage, { type: T }>)
        },
      })
    })
  }

  count(type: ServerMessage['type']) {
    return this.messages.filter((m) => m.type === type).length
  }

  close() {
    this.ws.close()
  }
}
