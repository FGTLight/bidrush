/**
 * The tab's single WebSocket to the API.
 *
 * - Reconnects with exponential backoff and jitter.
 * - Re-sends every subscription after a reconnect; the server answers each
 *   with a fresh snapshot, which replaces the room's state (resync).
 * - Keeps an estimate of the server clock (NTP-style pings): the server is
 *   the only source of truth for time; this offset is only for display.
 * - Bids sent while offline wait in an outbox and go out on reconnect with
 *   the same bidId, so the server's idempotency makes the retry safe.
 */
import {
  type BidMessage,
  type BrowserSignals,
  type ClientMessage,
  type ClockSample,
  estimateOffset,
  type ServerMessage,
  serverMessageSchema,
} from '@bidrush/shared'

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

type Listener = (message: ServerMessage) => void

export interface RealtimeOptions {
  /** Collected once per connection, for the anti-bot engine. */
  signals?: () => BrowserSignals
  WebSocketImpl?: typeof WebSocket
  random?: () => number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const MAX_BACKOFF_MS = 10_000
const CLOCK_SAMPLES = 8
const CLOCK_RESYNC_MS = 30_000

/** "Equal jitter": half fixed, half random, so reconnect storms spread out. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt)
  return Math.round(cap / 2 + (random() * cap) / 2)
}

export class RealtimeClient {
  status: ConnectionStatus = 'closed'
  /** serverTime ≈ Date.now() + offsetMs */
  offsetMs = 0
  userId: string | null = null

  private socket: WebSocket | null = null
  private attempt = 0
  private reconnectTimer: unknown = null
  private clockTimer: unknown = null
  private stopped = true
  private readonly listeners = new Set<Listener>()
  private readonly statusListeners = new Set<() => void>()
  private readonly subscriptions = new Map<string, number>()
  private readonly outbox = new Map<string, BidMessage>()
  private readonly pings = new Map<number, number>()
  private samples: ClockSample[] = []
  private readonly WS: typeof WebSocket
  private readonly random: () => number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    private readonly url: string,
    private readonly options: RealtimeOptions = {},
  ) {
    this.WS = options.WebSocketImpl ?? WebSocket
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer =
      options.clearTimer ??
      ((h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>)
      })
  }

  connect() {
    this.stopped = false
    this.open()
  }

  close() {
    this.stopped = true
    this.clearTimer(this.reconnectTimer)
    this.clearTimer(this.clockTimer)
    this.socket?.close(1000)
    this.socket = null
    this.setStatus('closed')
  }

  /** Reconnect now, e.g. after sign-in so the handshake sees the new cookie. */
  reconnect() {
    this.socket?.close(1000)
    this.socket = null
    this.attempt = 0
    if (!this.stopped) this.open()
  }

  on(listener: Listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onStatus(listener: () => void) {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /** Reference-counted; returns the unsubscribe function. */
  subscribe(auctionId: string) {
    const count = this.subscriptions.get(auctionId) ?? 0
    this.subscriptions.set(auctionId, count + 1)
    if (count === 0) this.send({ type: 'subscribe', auctionId })
    return () => {
      const current = this.subscriptions.get(auctionId) ?? 0
      if (current <= 1) {
        this.subscriptions.delete(auctionId)
        this.send({ type: 'unsubscribe', auctionId })
      } else {
        this.subscriptions.set(auctionId, current - 1)
      }
    }
  }

  /** Sends now, or as soon as the connection is back (same bidId). */
  sendBid(message: BidMessage) {
    this.outbox.set(message.bidId, message)
    this.send(message)
  }

  serverNow() {
    return this.now() + this.offsetMs
  }

  // ---------------------------------------------------------------- internals

  private open() {
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const socket = new this.WS(this.url)
    this.socket = socket

    socket.onopen = () => {
      if (socket !== this.socket) return
      this.attempt = 0
      this.setStatus('open')
      if (this.options.signals) this.send({ type: 'hello', signals: this.options.signals() })
      for (const auctionId of this.subscriptions.keys()) this.send({ type: 'subscribe', auctionId })
      for (const bid of this.outbox.values()) this.send(bid)
      this.syncClock()
    }

    socket.onmessage = (event: MessageEvent) => {
      if (socket !== this.socket || typeof event.data !== 'string') return
      let json: unknown
      try {
        json = JSON.parse(event.data)
      } catch {
        return
      }
      const parsed = serverMessageSchema.safeParse(json)
      if (!parsed.success) return
      this.handle(parsed.data)
    }

    socket.onclose = () => {
      if (socket !== this.socket) return
      this.socket = null
      this.clearTimer(this.clockTimer)
      if (this.stopped) return
      this.setStatus('reconnecting')
      const delay = backoffDelay(this.attempt, this.random)
      this.attempt += 1
      this.reconnectTimer = this.setTimer(() => {
        this.open()
      }, delay)
    }
  }

  private handle(message: ServerMessage) {
    switch (message.type) {
      case 'welcome':
        this.userId = message.userId
        break
      case 'pong': {
        const sentAt = this.pings.get(message.clientTime)
        if (sentAt !== undefined) {
          this.pings.delete(message.clientTime)
          this.samples = [
            ...this.samples,
            { sentAt, serverTime: message.serverTime, receivedAt: this.now() },
          ].slice(-CLOCK_SAMPLES)
          this.offsetMs = estimateOffset(this.samples)
        }
        return // internal
      }
      case 'bid_ack':
        this.outbox.delete(message.bidId)
        break
    }
    for (const listener of this.listeners) listener(message)
  }

  /** A few pings now, then one every 30 s. */
  private syncClock() {
    for (let i = 0; i < 4; i++) {
      this.setTimer(() => {
        this.ping()
      }, i * 150)
    }
    const loop = () => {
      this.ping()
      this.clockTimer = this.setTimer(loop, CLOCK_RESYNC_MS)
    }
    this.clockTimer = this.setTimer(loop, CLOCK_RESYNC_MS)
  }

  private ping() {
    const clientTime = this.now() + this.random() // unique key per ping
    this.pings.set(clientTime, this.now())
    this.send({ type: 'ping', clientTime })
  }

  private send(message: ClientMessage) {
    if (this.socket?.readyState === this.WS.OPEN) this.socket.send(JSON.stringify(message))
  }

  private setStatus(status: ConnectionStatus) {
    if (status === this.status) return
    this.status = status
    for (const listener of this.statusListeners) listener()
  }
}

/** ws(s)://host/ws next to the API: same origin by default. */
export function realtimeUrl(apiUrl: string, location: Location = window.location): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined
  if (explicit) return explicit
  const base = new URL(apiUrl, location.href)
  const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  // Same-origin API under /api: the WebSocket is proxied at /ws.
  const path = apiUrl.startsWith('/') ? '/ws' : `${base.pathname.replace(/\/$/, '')}/ws`
  return `${protocol}//${base.host}${path}`
}
