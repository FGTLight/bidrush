import { Redis } from 'ioredis'

/**
 * Redis connection. Used for rate limiting now; pub/sub, auction timers and
 * locks build on it later. Commands made while disconnected fail fast
 * instead of queueing, so a Redis outage surfaces as errors, not hangs.
 */
export function createRedis(url: string) {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: true,
  })
  return {
    redis,
    connect: async () => {
      await redis.connect()
    },
    close: async () => {
      await redis.quit().catch(() => {
        redis.disconnect()
      })
    },
  }
}

export type { Redis }
