/**
 * WebSocket endpoint: one connection per browser tab.
 *
 * Handshake: the same session cookie as HTTP authenticates the socket
 * (guests may watch but not bid), and the Origin must be on the allowlist,
 * which blocks cross-site WebSocket hijacking with the user's cookie.
 *
 * Messages from one socket are handled strictly in order. Accepted bids are
 * published to Redis and reach every subscriber on every instance.
 */
import {
  type BidMessage,
  bidErrorMessages,
  type BrowserSignals,
  clientMessageSchema,
  type ServerMessage,
  WS_LIMITS,
  WS_PATH,
} from '@bidrush/shared'
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'

import type { AuthContext } from '../auth/sessions'
import { isAllowedOrigin } from '../auth/plugin'
import { getAuction, recentBids } from '../auctions/views'
import { placeBid } from '../bids/engine'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { getWallet } from '../ledger/ledger'
import { auctionChannel, type Broker, userChannel } from './broker'
import { frameToString } from './frames'
import { TokenBucket } from './token-bucket'

const MAX_SUBSCRIPTIONS = 20

export interface RealtimeDeps {
  config: Config
  db: Db
  broker: Broker
}

/** Live connections of this instance (metrics, heartbeat, shutdown). */
export class ConnectionRegistry {
  readonly connections = new Set<Connection>()
  get size() {
    return this.connections.size
  }
}

class Connection {
  private readonly subscriptions = new Map<string, () => Promise<void>>()
  private unsubscribeUser: (() => Promise<void>) | null = null
  private readonly bucket = new TokenBucket(10, 20)
  /** Messages are processed one after another. */
  private queue: Promise<void> = Promise.resolve()
  alive = true
  signals: BrowserSignals | null = null

  constructor(
    readonly socket: WebSocket,
    readonly auth: AuthContext | null,
    readonly ip: string,
    private readonly deps: RealtimeDeps,
    private readonly log: FastifyBaseLogger,
  ) {}

  send(message: ServerMessage) {
    this.sendRaw(JSON.stringify(message))
  }

  sendRaw(payload: string) {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(payload)
  }

  async open() {
    this.send({ type: 'welcome', userId: this.auth?.userId ?? null, serverTime: Date.now() })
    if (this.auth) {
      this.unsubscribeUser = await this.deps.broker.subscribe(
        userChannel(this.auth.userId),
        (payload) => {
          this.sendRaw(payload)
        },
      )
    }
  }

  enqueue(raw: string) {
    this.queue = this.queue
      .then(() => this.handle(raw))
      .catch((err: unknown) => {
        this.log.error({ err }, 'ws message failed')
        this.send({ type: 'error', code: 'INTERNAL', message: bidErrorMessages.INTERNAL })
      })
  }

  private async handle(raw: string) {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      this.send({ type: 'error', code: 'VALIDATION', message: 'Messages must be JSON.' })
      return
    }
    const parsed = clientMessageSchema.safeParse(json)
    if (!parsed.success) {
      // Reject bids with a typed ack when we can identify them.
      const bidId = (json as { type?: unknown; bidId?: unknown } | null)?.bidId
      if ((json as { type?: unknown } | null)?.type === 'bid' && typeof bidId === 'string') {
        this.rejectBid(bidId, 'VALIDATION')
      } else {
        this.send({ type: 'error', code: 'VALIDATION', message: 'Unknown or malformed message.' })
      }
      return
    }

    const message = parsed.data
    const waitMs = message.type === 'ping' ? 0 : this.bucket.take()
    if (waitMs > 0) {
      if (message.type === 'bid') this.rejectBid(message.bidId, 'RATE_LIMITED', waitMs)
      else
        this.send({ type: 'error', code: 'RATE_LIMITED', message: bidErrorMessages.RATE_LIMITED })
      return
    }

    switch (message.type) {
      case 'hello':
        this.signals = message.signals
        return
      case 'ping':
        this.send({ type: 'pong', clientTime: message.clientTime, serverTime: Date.now() })
        return
      case 'subscribe':
        return this.subscribe(message.auctionId)
      case 'unsubscribe':
        await this.subscriptions.get(message.auctionId)?.()
        this.subscriptions.delete(message.auctionId)
        return
      case 'bid':
        return this.bid(message)
    }
  }

  private async subscribe(auctionId: string) {
    if (!this.subscriptions.has(auctionId)) {
      if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
        this.send({
          type: 'error',
          code: 'TOO_MANY_SUBSCRIPTIONS',
          message: 'Watching too many auctions.',
        })
        return
      }
      // Subscribe first, then read: no event can fall between the snapshot
      // and the live stream (clients drop duplicates by bid seq).
      const unsubscribe = await this.deps.broker.subscribe(auctionChannel(auctionId), (payload) => {
        this.sendRaw(payload)
      })
      this.subscriptions.set(auctionId, unsubscribe)
    }
    const [auction, bids] = await Promise.all([
      getAuction(this.deps.db, auctionId),
      recentBids(this.deps.db, auctionId),
    ])
    if (!auction) {
      await this.subscriptions.get(auctionId)?.()
      this.subscriptions.delete(auctionId)
      this.send({
        type: 'error',
        code: 'AUCTION_NOT_FOUND',
        message: bidErrorMessages.AUCTION_NOT_FOUND,
      })
      return
    }
    // Resync on every (re)subscribe: the client replaces its state.
    this.send({ type: 'auction_snapshot', auction, recentBids: bids, serverTime: Date.now() })
  }

  private rejectBid(bidId: string, code: keyof typeof bidErrorMessages, retryAfterMs?: number) {
    this.send({
      type: 'bid_ack',
      status: 'rejected',
      bidId,
      code,
      message: bidErrorMessages[code],
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    })
  }

  private async bid(message: BidMessage) {
    if (!this.auth) {
      this.rejectBid(message.bidId, 'UNAUTHORIZED')
      return
    }
    const { db, broker } = this.deps
    const startedAt = performance.now()
    const result = await placeBid(db, {
      bidId: message.bidId,
      auctionId: message.auctionId,
      userId: this.auth.userId,
      amount: message.amount,
    })

    if (result.status === 'rejected') {
      this.send({
        type: 'bid_ack',
        status: 'rejected',
        bidId: message.bidId,
        code: result.code,
        message: result.message,
      })
      return
    }

    this.send({
      type: 'bid_ack',
      status: 'accepted',
      bidId: message.bidId,
      duplicate: result.duplicate,
      wallet: result.wallet,
    })
    if (result.duplicate) return

    const { bid, auction, outbid } = result
    await Promise.all([
      broker.publish(auctionChannel(bid.auctionId), {
        type: 'bid_placed',
        bid: {
          id: bid.id,
          auctionId: bid.auctionId,
          bidder: { id: this.auth.userId, displayName: this.auth.displayName },
          amount: bid.amount,
          seq: bid.seq,
          createdAt: bid.createdAt.toISOString(),
        },
        currentPrice: auction.currentPrice,
        bidCount: auction.bidCount,
        bidderCount: auction.bidderCount,
        endsAt: auction.endsAt.toISOString(),
        extendedMs: auction.extendedMs,
        extended: auction.extended,
      }),
      // The bidder's other tabs and the outbid user see their new balances.
      broker.publish(userChannel(this.auth.userId), { type: 'wallet', wallet: result.wallet }),
      outbid &&
        broker.publish(userChannel(outbid.userId), {
          type: 'wallet',
          wallet: await getWallet(db, outbid.userId),
        }),
    ])
    this.log.debug(
      { bidId: bid.id, auctionId: bid.auctionId, ms: performance.now() - startedAt },
      'bid accepted',
    )
  }

  async close() {
    const unsubscribes = [...this.subscriptions.values()]
    this.subscriptions.clear()
    if (this.unsubscribeUser) unsubscribes.push(this.unsubscribeUser)
    this.unsubscribeUser = null
    await Promise.all(unsubscribes.map((u) => u()))
  }
}

export async function realtimeRoutes(
  app: FastifyInstance,
  { deps, registry }: { deps: RealtimeDeps; registry: ConnectionRegistry },
) {
  // Refuse cross-site handshakes before upgrading.
  const checkOrigin = async (req: FastifyRequest) => {
    if (!isAllowedOrigin(deps.config, req.headers.origin)) {
      const error = new Error('WebSocket origin not allowed') as Error & {
        statusCode: number
        code: string
      }
      error.statusCode = 403
      error.code = 'FORBIDDEN_ORIGIN'
      throw error
    }
  }

  app.get(WS_PATH, { websocket: true, preValidation: checkOrigin }, (socket, req) => {
    const connection = new Connection(socket, req.auth, req.ip, deps, req.log)
    registry.connections.add(connection)

    // Listeners first (synchronously), so no early message is lost.
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        connection.send({ type: 'error', code: 'VALIDATION', message: 'Text frames only.' })
        return
      }
      connection.enqueue(frameToString(data))
    })
    socket.on('pong', () => {
      connection.alive = true
    })
    socket.on('close', () => {
      registry.connections.delete(connection)
      void connection.close()
    })
    socket.on('error', (err) => {
      req.log.warn({ err }, 'ws error')
    })

    connection.open().catch((err: unknown) => {
      req.log.error({ err }, 'ws open failed')
      socket.close(1011, 'internal error')
    })
  })

  // Heartbeat: a socket that missed the previous ping is dead (e.g. the
  // laptop went to sleep); terminate it so its subscriptions are released.
  const heartbeat = setInterval(() => {
    for (const c of registry.connections) {
      if (!c.alive) {
        c.socket.terminate()
        continue
      }
      c.alive = false
      c.socket.ping()
    }
  }, WS_LIMITS.heartbeatMs)
  app.addHook('onClose', async () => {
    clearInterval(heartbeat)
    for (const c of registry.connections) c.socket.close(1001, 'server shutting down')
  })
}
