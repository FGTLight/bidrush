/**
 * Cross-instance fan-out over Redis pub/sub.
 *
 * Any instance publishes an event once; every instance with local sockets
 * interested in that channel receives it and writes it to them. An
 * instance subscribes to a channel only while at least one of its sockets
 * needs it (reference counted), so traffic scales with interest, not with
 * the number of auctions.
 *
 * Payloads are serialized once by the publisher and forwarded as-is.
 */
import type { ServerMessage } from '@bidrush/shared'
import type { FastifyBaseLogger } from 'fastify'

import type { Redis } from '../redis'

const PREFIX = 'bidrush:'
export const auctionChannel = (auctionId: string) => `${PREFIX}auction:${auctionId}`
export const userChannel = (userId: string) => `${PREFIX}user:${userId}`
/** Lifecycle events (started/ended) for lobby pages watching every auction. */
export const LOBBY_CHANNEL = `${PREFIX}lobby`

type Listener = (payload: string) => void

export class Broker {
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly subscriber: Redis

  constructor(
    private readonly publisher: Redis,
    private readonly log: FastifyBaseLogger,
  ) {
    // A connection in subscriber mode can't run other commands.
    this.subscriber = publisher.duplicate({ lazyConnect: true, enableOfflineQueue: true })
    this.subscriber.on('message', (channel: string, payload: string) => {
      const set = this.listeners.get(channel)
      if (!set) return
      for (const listener of set) {
        try {
          listener(payload)
        } catch (err) {
          this.log.error({ err, channel }, 'broker listener failed')
        }
      }
    })
    this.subscriber.on('error', (err: unknown) => {
      this.log.warn({ err }, 'redis subscriber error')
    })
  }

  /**
   * Never blocks startup: if Redis is down the instance still serves (and
   * /health reports 503); ioredis keeps reconnecting and restores every
   * subscription by itself once Redis is back.
   */
  async start() {
    await this.subscriber.connect().catch((err: unknown) => {
      this.log.warn({ err }, 'redis subscriber not connected yet; retrying in background')
    })
  }

  async stop() {
    this.listeners.clear()
    await this.subscriber.quit().catch(() => {
      this.subscriber.disconnect()
    })
  }

  async publish(channel: string, message: ServerMessage) {
    await this.publisher.publish(channel, JSON.stringify(message))
  }

  /** Returns the function that undoes it. */
  async subscribe(channel: string, listener: Listener): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
      await this.subscriber.subscribe(channel)
    }
    set.add(listener)

    let active = true
    return async () => {
      if (!active) return
      active = false
      const current = this.listeners.get(channel)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.listeners.delete(channel)
        await this.subscriber.unsubscribe(channel).catch(() => undefined)
      }
    }
  }

  /** Channels this instance currently listens to (for metrics and tests). */
  get channelCount() {
    return this.listeners.size
  }
}
