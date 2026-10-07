import { backoffDelay, RealtimeClient, realtimeUrl } from './client'

/** A WebSocket double the tests can open, feed and close. */
class FakeSocket {
  static readonly OPEN = 1
  static instances: FakeSocket[] = []
  readonly OPEN = 1
  readyState = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  // test controls
  serverOpen() {
    this.readyState = 1
    this.onopen?.()
  }
  serverSend(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  serverDrop() {
    this.readyState = 3
    this.onclose?.()
  }
}

const auctionId = '0b6f1f1e-6a55-4c3e-9a8e-6a1f6d2b9c01'
const bidId = '1b6f1f1e-6a55-4c3e-9a8e-6a1f6d2b9c02'

function setup() {
  FakeSocket.instances = []
  const timers: { fn: () => void; ms: number }[] = []
  let now = 1_000
  const client = new RealtimeClient('ws://test/ws', {
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    random: () => 0.5,
    now: () => now,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => undefined,
    signals: () => ({ webdriver: false }),
    solve: () => Promise.resolve('nonce-42'),
  })
  const runTimers = (maxMs: number) => {
    for (const t of timers.splice(0).filter((x) => x.ms <= maxMs)) t.fn()
  }
  return {
    client,
    timers,
    runTimers,
    socket: () => FakeSocket.instances.at(-1)!,
    advance: (ms: number) => (now += ms),
  }
}

const sentTypes = (s: FakeSocket) => s.sent.map((m) => (m as { type: string }).type)

describe('backoffDelay', () => {
  it('grows exponentially, with jitter, up to a cap', () => {
    expect(backoffDelay(0, () => 0)).toBe(250)
    expect(backoffDelay(0, () => 1)).toBe(500)
    expect(backoffDelay(3, () => 1)).toBe(4_000)
    expect(backoffDelay(20, () => 1)).toBe(10_000)
  })
})

describe('RealtimeClient', () => {
  it('says hello and subscribes once the socket opens', () => {
    const { client, socket } = setup()
    client.subscribe(auctionId)
    client.connect()
    socket().serverOpen()
    expect(client.status).toBe('open')
    expect(sentTypes(socket()).slice(0, 2)).toEqual(['hello', 'subscribe'])
  })

  it('reference-counts subscriptions', () => {
    const { client, socket } = setup()
    client.connect()
    socket().serverOpen()
    const a = client.subscribe(auctionId)
    const b = client.subscribe(auctionId)
    a()
    expect(sentTypes(socket()).filter((t) => t.includes('subscribe'))).toEqual(['subscribe'])
    b()
    expect(sentTypes(socket()).at(-1)).toBe('unsubscribe')
  })

  it('reconnects with backoff and resubscribes (resync)', () => {
    const { client, socket, timers, runTimers } = setup()
    client.subscribe(auctionId)
    client.connect()
    socket().serverOpen()
    timers.length = 0 // ignore clock-sync timers

    socket().serverDrop()
    expect(client.status).toBe('reconnecting')
    expect(timers.at(-1)?.ms).toBe(375) // attempt 0 with random 0.5

    runTimers(1_000)
    expect(FakeSocket.instances).toHaveLength(2)
    socket().serverOpen()
    expect(client.status).toBe('open')
    expect(sentTypes(socket())).toContain('subscribe')
  })

  it('keeps an offline bid and resends it with the same bidId', () => {
    const { client, socket, runTimers } = setup()
    client.connect()
    socket().serverOpen()
    socket().serverDrop()

    const bid = {
      type: 'bid' as const,
      bidId,
      auctionId,
      amount: 150,
      interaction: { trustedEvents: 1, honeypot: '', reactionMs: 400 },
    }
    client.sendBid(bid)
    runTimers(1_000)
    socket().serverOpen()
    expect(socket().sent).toContainEqual(bid)

    // Once acknowledged, it is not sent again on the next reconnect.
    socket().serverSend({
      type: 'bid_ack',
      status: 'accepted',
      bidId,
      duplicate: true,
      wallet: { available: 850, reserved: 150 },
    })
    socket().serverDrop()
    runTimers(10_000)
    socket().serverOpen()
    expect(socket().sent).not.toContainEqual(bid)
  })

  it('estimates the server clock from pongs', () => {
    const { client, socket, runTimers, advance } = setup()
    client.connect()
    socket().serverOpen()
    runTimers(0) // first ping
    const ping = socket().sent.find((m) => (m as { type: string }).type === 'ping') as {
      clientTime: number
    }
    advance(40) // 40 ms round trip
    socket().serverSend({
      type: 'pong',
      clientTime: ping.clientTime,
      serverTime: 1_000 + 20 + 5_000,
    })
    expect(client.offsetMs).toBe(5_000)
  })

  it('solves a challenge and resends the same bid with the answer', async () => {
    const { client, socket } = setup()
    client.connect()
    socket().serverOpen()
    const bid = {
      type: 'bid' as const,
      bidId,
      auctionId,
      amount: 150,
      interaction: { trustedEvents: 0, honeypot: '', reactionMs: null },
    }
    client.sendBid(bid)
    socket().serverSend({ type: 'challenge', id: 'ch-1', prefix: 'abc', difficulty: 3 })
    socket().serverSend({
      type: 'bid_ack',
      status: 'rejected',
      bidId,
      code: 'CHALLENGE_REQUIRED',
      message: 'Prove it',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(socket().sent.at(-1)).toEqual({ ...bid, challenge: { id: 'ch-1', nonce: 'nonce-42' } })
  })

  it('gives up after two challenges for the same bid', async () => {
    const { client, socket } = setup()
    client.connect()
    socket().serverOpen()
    const bid = {
      type: 'bid' as const,
      bidId,
      auctionId,
      amount: 150,
      interaction: { trustedEvents: 0, honeypot: '', reactionMs: null },
    }
    client.sendBid(bid)
    for (let i = 0; i < 3; i++) {
      socket().serverSend({ type: 'challenge', id: `ch-${i}`, prefix: 'abc', difficulty: 3 })
      socket().serverSend({
        type: 'bid_ack',
        status: 'rejected',
        bidId,
        code: 'CHALLENGE_REQUIRED',
        message: 'Prove it',
      })
      await Promise.resolve()
      await Promise.resolve()
    }
    const resends = socket().sent.filter((m) => (m as { challenge?: unknown }).challenge)
    expect(resends).toHaveLength(2)
  })

  it('ignores messages that fail validation', () => {
    const { client, socket } = setup()
    const seen: unknown[] = []
    client.on((m) => seen.push(m))
    client.connect()
    socket().serverOpen()
    socket().serverSend({ type: 'bid_placed', bid: 'nonsense' })
    expect(seen).toEqual([])
  })
})

describe('realtimeUrl', () => {
  const location = new URL('https://bidrush.app/auctions') as unknown as Location
  it('uses /ws on the same origin for a relative API', () => {
    expect(realtimeUrl('/api', location)).toBe('wss://bidrush.app/ws')
  })
  it('follows an API hosted elsewhere', () => {
    expect(realtimeUrl('https://api.bidrush.app', location)).toBe('wss://api.bidrush.app/ws')
  })
})
