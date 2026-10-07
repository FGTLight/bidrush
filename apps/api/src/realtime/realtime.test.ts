import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { signUp } from '../../test/app'
import { createAuction, expectLedgerConsistent, resetDb, useTestDb } from '../../test/db'
import { startInstance, TestSocket } from '../../test/ws'
import { auctions, users } from '../db/schema'
import { getWallet } from '../ledger/ledger'

const { db } = useTestDb(20)
// Two API instances sharing Postgres and Redis, like api-1/api-2 in Compose.
const a = await startInstance(db, 'api-a')
const b = await startInstance(db, 'api-b')

beforeEach(async () => {
  await resetDb(db)
  await a.redis.flushdb()
})

const interaction = { trustedEvents: 2, honeypot: '', reactionMs: 600 }
const bidMessage = (auctionId: string, amount: number, bidId: string = randomUUID()) => ({
  type: 'bid',
  bidId,
  auctionId,
  amount,
  interaction,
})

async function signedInSocket(url: string) {
  const session = await signUp(a.app)
  const socket = await TestSocket.connect(url, { cookie: session.cookie })
  const welcome = await socket.next('welcome')
  return { session, socket, userId: welcome.userId! }
}

describe('handshake', () => {
  it('lets guests watch and identifies signed-in users', async () => {
    const guest = await TestSocket.connect(a.wsUrl)
    expect(await guest.next('welcome')).toMatchObject({ userId: null })

    const { session, userId } = await signedInSocket(b.wsUrl)
    expect(userId).toBe(session.body.user.id)
  })

  it('refuses handshakes from foreign origins', async () => {
    const session = await signUp(a.app)
    await expect(
      TestSocket.connect(a.wsUrl, { cookie: session.cookie, origin: 'https://evil.example' }),
    ).rejects.toThrow(/403/)
  })
})

describe('subscriptions', () => {
  it('sends a snapshot of the auction', async () => {
    const auction = await createAuction(db, { title: 'Mechanical keyboard' })
    const socket = await TestSocket.connect(a.wsUrl)
    socket.send({ type: 'subscribe', auctionId: auction.id })
    const snapshot = await socket.next('auction_snapshot')
    expect(snapshot.auction).toMatchObject({
      id: auction.id,
      title: 'Mechanical keyboard',
      status: 'live',
    })
    expect(snapshot.recentBids).toEqual([])
  })

  it('reports unknown auctions', async () => {
    const socket = await TestSocket.connect(a.wsUrl)
    socket.send({ type: 'subscribe', auctionId: randomUUID() })
    expect(await socket.next('error')).toMatchObject({ code: 'AUCTION_NOT_FOUND' })
  })
})

describe('bidding over WebSockets', () => {
  it('acks the bidder and broadcasts to watchers on another instance', async () => {
    const auction = await createAuction(db, { startingPrice: 100 })
    const watcher = await TestSocket.connect(b.wsUrl)
    watcher.send({ type: 'subscribe', auctionId: auction.id })
    await watcher.next('auction_snapshot')

    const { socket: bidder } = await signedInSocket(a.wsUrl)
    const bidId = randomUUID()
    bidder.send(bidMessage(auction.id, 150, bidId))

    expect(await bidder.next('bid_ack')).toMatchObject({
      status: 'accepted',
      bidId,
      duplicate: false,
      wallet: { available: 850, reserved: 150 },
    })
    expect(await watcher.next('bid_placed')).toMatchObject({
      bid: { id: bidId, amount: 150, seq: 1 },
      currentPrice: 150,
      bidCount: 1,
    })
  })

  it('tells the outbid user their credits came back, on any instance', async () => {
    const auction = await createAuction(db, { startingPrice: 100 })
    const ada = await signedInSocket(b.wsUrl)
    const bob = await signedInSocket(a.wsUrl)

    ada.socket.send(bidMessage(auction.id, 100))
    await ada.socket.next('bid_ack')
    bob.socket.send(bidMessage(auction.id, 120))
    await bob.socket.next('bid_ack')

    expect(await ada.socket.next('wallet', (m) => m.wallet.reserved === 0)).toMatchObject({
      wallet: { available: 1_000, reserved: 0 },
    })
  })

  it('answers a retried bid with a duplicate ack and broadcasts it once', async () => {
    const auction = await createAuction(db)
    const watcher = await TestSocket.connect(b.wsUrl)
    watcher.send({ type: 'subscribe', auctionId: auction.id })
    await watcher.next('auction_snapshot')

    const { socket } = await signedInSocket(a.wsUrl)
    const message = bidMessage(auction.id, 200)
    socket.send(message)
    socket.send(message)
    await socket.next('bid_ack', (m) => m.status === 'accepted' && m.duplicate)
    await watcher.next('bid_placed')
    await new Promise((r) => setTimeout(r, 100))
    expect(watcher.count('bid_placed')).toBe(1)
  })

  it('rejects guest bids and malformed messages with typed errors', async () => {
    const auction = await createAuction(db)
    const guest = await TestSocket.connect(a.wsUrl)
    const bidId = randomUUID()
    guest.send(bidMessage(auction.id, 200, bidId))
    expect(await guest.next('bid_ack')).toMatchObject({
      status: 'rejected',
      bidId,
      code: 'UNAUTHORIZED',
    })

    const invalidId = randomUUID()
    guest.send(bidMessage(auction.id, 0, invalidId))
    expect(await guest.next('bid_ack', (m) => m.bidId === invalidId)).toMatchObject({
      status: 'rejected',
      code: 'VALIDATION',
    })

    guest.ws.send('not json')
    expect(await guest.next('error')).toMatchObject({ code: 'VALIDATION' })
  })

  it('closes connections that send oversized frames', async () => {
    const socket = await TestSocket.connect(a.wsUrl)
    const closed = new Promise<number>((resolve) => socket.ws.once('close', resolve))
    socket.ws.send('x'.repeat(10_000))
    expect(await closed).toBe(1009) // "message too big"
  })

  it('rate-limits message floods per connection', async () => {
    const auction = await createAuction(db)
    const socket = await TestSocket.connect(a.wsUrl)
    for (let i = 0; i < 30; i++) socket.send({ type: 'subscribe', auctionId: auction.id })
    expect(await socket.next('error', (m) => m.code === 'RATE_LIMITED')).toBeDefined()
  })

  it('broadcasts accepted bids across instances in well under 50 ms', async () => {
    const auction = await createAuction(db, { startingPrice: 100, minIncrement: 10 })
    const watcher = await TestSocket.connect(b.wsUrl)
    watcher.send({ type: 'subscribe', auctionId: auction.id })
    await watcher.next('auction_snapshot')
    const ada = await signedInSocket(a.wsUrl)
    const bob = await signedInSocket(a.wsUrl)

    const latencies: number[] = []
    for (let i = 0; i < 20; i++) {
      const bidder = i % 2 === 0 ? ada : bob
      const bidId = randomUUID()
      const sentAt = performance.now()
      bidder.socket.send(bidMessage(auction.id, 100 + i * 10, bidId))
      await watcher.next('bid_placed', (m) => m.bid.id === bidId)
      latencies.push(performance.now() - sentAt)
    }
    latencies.sort((x, y) => x - y)
    const p50 = latencies[9]!
    const p95 = latencies[18]!
    console.info(
      `bid → broadcast on the other instance: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
    )
    expect(p50).toBeLessThan(50)
  })
})

describe('auction lifecycle', () => {
  it('starts scheduled auctions and tells watchers', async () => {
    const auction = await createAuction(db, {
      status: 'scheduled',
      startsAt: new Date(Date.now() - 10),
      endsAt: new Date(Date.now() + 60_000),
    })
    const watcher = await TestSocket.connect(b.wsUrl)
    watcher.send({ type: 'subscribe', auctionId: auction.id })
    await watcher.next('auction_snapshot')

    await Promise.all([a.app.realtime.scheduler.tick(), b.app.realtime.scheduler.tick()])
    expect(await watcher.next('auction_started')).toMatchObject({
      auction: { id: auction.id, status: 'live' },
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(watcher.count('auction_started')).toBe(1)
  })

  it('closes and settles exactly once with two instances racing', async () => {
    const auction = await createAuction(db, {
      startingPrice: 100,
      endsAt: new Date(Date.now() + 800),
    })
    const watcher = await TestSocket.connect(a.wsUrl)
    watcher.send({ type: 'subscribe', auctionId: auction.id })
    await watcher.next('auction_snapshot')
    const winner = await signedInSocket(b.wsUrl)
    winner.socket.send(bidMessage(auction.id, 300))
    const ack = await winner.socket.next('bid_ack')
    expect(ack.status).toBe('accepted')

    // The bid landed in the soft-close window: wait for the extended end.
    const [row] = await db.select().from(auctions).where(eq(auctions.id, auction.id))
    await new Promise((r) => setTimeout(r, row!.endsAt.getTime() - Date.now() + 50))

    // Both instances' schedulers fire at once, several times.
    await Promise.all(
      Array.from({ length: 5 }, () => [
        a.app.realtime.scheduler.tick(),
        b.app.realtime.scheduler.tick(),
      ]).flat(),
    )

    expect(await watcher.next('auction_ended')).toMatchObject({
      auctionId: auction.id,
      winner: { id: winner.userId },
      finalPrice: 300,
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(watcher.count('auction_ended')).toBe(1)

    const [ended] = await db.select().from(auctions).where(eq(auctions.id, auction.id))
    expect(ended).toMatchObject({ status: 'ended' })
    expect(ended?.settledAt).not.toBeNull()
    expect(await getWallet(db, winner.userId)).toEqual({ available: 700, reserved: 0 })
    const [settles] = await db.execute<{ n: string }>(
      sql`select count(*) as n from ledger_transactions where kind = 'settle'`,
    )
    expect(Number(settles?.n)).toBe(1)
    await expectLedgerConsistent(db)

    // Bids after the end are refused.
    winner.socket.send(bidMessage(auction.id, 1_000))
    expect(await winner.socket.next('bid_ack', (m) => m.status === 'rejected')).toMatchObject({
      code: 'AUCTION_ENDED',
    })
  })

  it('ends auctions without bids, settling nothing', async () => {
    const auction = await createAuction(db, { endsAt: new Date(Date.now() + 50) })
    await new Promise((r) => setTimeout(r, 100))
    await a.app.realtime.scheduler.tick()
    const [ended] = await db.select().from(auctions).where(eq(auctions.id, auction.id))
    expect(ended).toMatchObject({ status: 'ended', leaderId: null })
  })
})

describe('admin', () => {
  it('lets admins schedule auctions with the configured soft-close rules', async () => {
    const admin = await signUp(a.app)
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.body.user.id))
    const startsAt = new Date(Date.now() + 60_000).toISOString()
    const res = await a.app.inject({
      method: 'POST',
      url: '/admin/auctions',
      headers: admin.headers,
      payload: { title: 'Signed vinyl', startingPrice: 50, minIncrement: 5, startsAt },
    })
    expect(res.statusCode).toBe(201)
    const { auction } = res.json<{ auction: { id: string; status: string; endsAt: string } }>()
    expect(auction.status).toBe('scheduled')
    expect(Date.parse(auction.endsAt) - Date.parse(startsAt)).toBe(60_000)
  })

  it('refuses non-admins', async () => {
    const user = await signUp(a.app)
    const res = await a.app.inject({
      method: 'POST',
      url: '/admin/auctions',
      headers: user.headers,
      payload: {
        title: 'Nope',
        startingPrice: 1,
        minIncrement: 1,
        startsAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    expect(res.statusCode).toBe(403)
  })
})
