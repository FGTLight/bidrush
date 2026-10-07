/** The anti-bot engine end to end: real WebSockets, Redis and Postgres. */
import { createHash, randomUUID } from 'node:crypto'

import type { BrowserSignals } from '@bidrush/shared'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { signUp } from '../../test/app'
import { createAuction, resetDb, useTestDb } from '../../test/db'
import { startInstance, TestSocket } from '../../test/ws'
import { riskEvents, userRisk, users } from '../db/schema'

const { db } = useTestDb(20)
const api = await startInstance(db, 'api-antibot', {
  ANTIBOT_MODE: 'enforce',
  ANTIBOT_POW_DIFFICULTY: '3',
})
const monitor = await startInstance(db, 'api-monitor', { ANTIBOT_MODE: 'monitor' })

beforeEach(async () => {
  await Promise.all([api.app.realtime.antibot.drain(), monitor.app.realtime.antibot.drain()])
  await resetDb(db)
  await api.redis.flushdb()
})

const humanSignals: BrowserSignals = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36',
  webdriver: false,
  languages: ['en-US', 'en'],
  timezone: 'UTC',
  timezoneOffset: 0,
  screen: { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1 },
  hardwareConcurrency: 8,
  touchPoints: 0,
  canvasHash: 'human-canvas',
}

async function bidder(url: string, signals: BrowserSignals | null) {
  const session = await signUp(api.app)
  const socket = await TestSocket.connect(url, { cookie: session.cookie })
  await socket.next('welcome')
  if (signals) socket.send({ type: 'hello', signals })
  return { session, socket, userId: session.body.user.id }
}

function bid(
  socket: TestSocket,
  auctionId: string,
  amount: number,
  extra: {
    trustedEvents?: number
    honeypot?: string
    bidId?: string
    challenge?: { id: string; nonce: string }
  } = {},
) {
  const bidId = extra.bidId ?? randomUUID()
  const since = socket.mark()
  socket.send({
    type: 'bid',
    bidId,
    auctionId,
    amount,
    interaction: {
      trustedEvents: extra.trustedEvents ?? 2,
      honeypot: extra.honeypot ?? '',
      reactionMs: 800,
    },
    ...(extra.challenge && { challenge: extra.challenge }),
  })
  // Only this send's answer: a retried bidId has older acks in the log.
  return socket.next('bid_ack', (m) => m.bidId === bidId, 5_000, since)
}

function solve(prefix: string, difficulty: number) {
  for (let n = 0; ; n++) {
    const nonce = n.toString(36)
    if (
      createHash('sha256')
        .update(prefix + nonce)
        .digest('hex')
        .startsWith('0'.repeat(difficulty))
    )
      return nonce
  }
}

describe('anti-bot engine (enforce mode)', () => {
  it('lets a human-looking bidder through and stores nothing', async () => {
    const auction = await createAuction(db)
    const human = await bidder(api.wsUrl, humanSignals)
    expect(await bid(human.socket, auction.id, 100)).toMatchObject({ status: 'accepted' })
    expect(await db.select().from(riskEvents)).toHaveLength(0)
  })

  it('blocks webdriver automation with a typed error and an audit record', async () => {
    const auction = await createAuction(db)
    const bot = await bidder(api.wsUrl, { ...humanSignals, webdriver: true })
    expect(await bid(bot.socket, auction.id, 100)).toMatchObject({
      status: 'rejected',
      code: 'SUSPECTED_BOT',
    })

    await expect.poll(() => db.select().from(riskEvents)).toHaveLength(1)
    const [event] = await db.select().from(riskEvents)
    expect(event).toMatchObject({ userId: bot.userId, level: 'block' })
    expect(event?.signals.map((s) => s.name)).toContain('automation')
    const [risk] = await db.select().from(userRisk)
    expect(risk).toMatchObject({ userId: bot.userId, level: 'block' })
  })

  it('blocks honeypot fillers', async () => {
    const auction = await createAuction(db)
    const bot = await bidder(api.wsUrl, humanSignals)
    expect(await bid(bot.socket, auction.id, 100, { honeypot: 'buy cheap' })).toMatchObject({
      code: 'SUSPECTED_BOT',
    })
  })

  it('auto-blocks the account after repeated block decisions', async () => {
    const auction = await createAuction(db)
    const bot = await bidder(api.wsUrl, { ...humanSignals, webdriver: true })
    for (let i = 0; i < 3; i++) await bid(bot.socket, auction.id, 100 + i * 10)

    await expect
      .poll(
        async () => (await db.select().from(users).where(eq(users.id, bot.userId)))[0]?.blockedAt,
      )
      .not.toBeNull()
    const autoBlocked = await db.select().from(riskEvents).where(eq(riskEvents.autoBlocked, true))
    expect(autoBlocked).toHaveLength(1)
  })

  it('challenges a suspicious client, and accepts the bid once the proof-of-work is solved', async () => {
    const auction = await createAuction(db)
    // No handshake signals and no real input events: suspicious, not conclusive.
    const suspect = await bidder(api.wsUrl, null)
    const bidId = randomUUID()
    const first = await bid(suspect.socket, auction.id, 100, { trustedEvents: 0, bidId })
    expect(first).toMatchObject({ status: 'rejected', code: 'CHALLENGE_REQUIRED' })

    const challenge = await suspect.socket.next('challenge')
    const nonce = solve(challenge.prefix, challenge.difficulty)
    const retry = await bid(suspect.socket, auction.id, 100, {
      trustedEvents: 0,
      bidId, // same bid, retried
      challenge: { id: challenge.id, nonce },
    })
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: 'accepted', duplicate: false })
  })

  it('refuses wrong or replayed challenge answers', async () => {
    const auction = await createAuction(db)
    const suspect = await bidder(api.wsUrl, null)
    await bid(suspect.socket, auction.id, 100, { trustedEvents: 0 })
    const challenge = await suspect.socket.next('challenge')
    const wrong = await bid(suspect.socket, auction.id, 100, {
      trustedEvents: 0,
      challenge: { id: challenge.id, nonce: 'not-a-solution' },
    })
    expect(wrong).toMatchObject({ code: 'CHALLENGE_REQUIRED' })
  })

  it('rate-limits floods on arrival, even while earlier bids are throttled', async () => {
    const auction = await createAuction(db)
    const spammer = await bidder(api.wsUrl, humanSignals)
    const since = spammer.socket.mark()
    for (let i = 0; i < 30; i++) {
      spammer.socket.send({
        type: 'bid',
        bidId: randomUUID(),
        auctionId: auction.id,
        amount: 1_000 + i * 10,
        interaction: { trustedEvents: 1, honeypot: '', reactionMs: 500 },
      })
    }
    const limited = await spammer.socket.next(
      'bid_ack',
      (m) => m.status === 'rejected' && m.code === 'RATE_LIMITED',
      2_000,
      since,
    )
    expect(limited.status === 'rejected' && limited.retryAfterMs).toBeGreaterThan(0)
  })

  it('measures reaction time to being outbid on the server', async () => {
    const auction = await createAuction(db, { startingPrice: 100, minIncrement: 10 })
    const engine = api.app.realtime.antibot
    const userId = randomUUID()
    const attempt = {
      userId,
      auctionId: auction.id,
      bidId: randomUUID(),
      ip: '198.51.100.9',
      receivedAt: Date.now(),
      interaction: { trustedEvents: 1, honeypot: '', reactionMs: 40 },
      browser: humanSignals,
    }
    // Three accepted bids, each 40 ms after being outbid.
    for (let i = 0; i < 3; i++) {
      const now = Date.now()
      await engine.noteOutbid(userId, auction.id, now - 40)
      await engine.noteAccepted(userId, auction.id, now)
    }
    const last = await engine.evaluate({ ...attempt, bidId: randomUUID(), receivedAt: Date.now() })
    const reaction = last.signals.find((s) => s.name === 'reaction_speed')
    expect(reaction?.score).toBe(1)
    expect(reaction?.reason).toMatch(/median 4\d ms/)
  })

  it('does not count a stale bid that merely arrives after an outbid', async () => {
    const auction = await createAuction(db)
    const engine = api.app.realtime.antibot
    const userId = randomUUID()
    for (let i = 0; i < 3; i++) {
      // Outbid, and the follow-up bid is refused: nothing is measured.
      await engine.noteOutbid(userId, auction.id, Date.now() - 30)
    }
    const decision = await engine.evaluate({
      userId,
      auctionId: auction.id,
      bidId: randomUUID(),
      ip: '198.51.100.10',
      receivedAt: Date.now(),
      interaction: { trustedEvents: 1, honeypot: '', reactionMs: 30 },
      browser: humanSignals,
    })
    expect(decision.signals.find((s) => s.name === 'reaction_speed')).toBeUndefined()
  })

  it('explains decisions that rest on remembered evidence', async () => {
    const auction = await createAuction(db)
    const bot = await bidder(api.wsUrl, { ...humanSignals, webdriver: true })
    await bid(bot.socket, auction.id, 100)
    // It now claims a normal browser, but the memory keeps the evidence.
    bot.socket.send({ type: 'hello', signals: humanSignals })
    const ack = await bid(bot.socket, auction.id, 110)
    expect(ack).toMatchObject({ status: 'rejected' })
    await expect.poll(() => db.select().from(riskEvents)).toHaveLength(2)
    const [, second] = await db.select().from(riskEvents).orderBy(riskEvents.id)
    expect(second?.signals[0]?.name).toBe('recent_history')
    expect(second?.signals[0]?.reason).toMatch(/webdriver/)
  })
})

describe('monitor mode', () => {
  it('records what it would do but lets the bid through', async () => {
    const auction = await createAuction(db)
    const bot = await bidder(monitor.wsUrl, { ...humanSignals, webdriver: true })
    expect(await bid(bot.socket, auction.id, 100)).toMatchObject({ status: 'accepted' })
    await expect.poll(() => db.select().from(riskEvents)).toHaveLength(1)
    const [event] = await db.select().from(riskEvents)
    expect(event?.level).toBe('block')
  })
})

describe('admin review', () => {
  it('lists flagged users with reasons and clears false positives', async () => {
    const auction = await createAuction(db)
    const admin = await signUp(api.app)
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.body.user.id))
    const bot = await bidder(api.wsUrl, { ...humanSignals, webdriver: true })
    await bid(bot.socket, auction.id, 100)
    await expect.poll(() => db.select().from(userRisk)).toHaveLength(1)

    const list = await api.app.inject({ url: '/admin/risk/users', headers: admin.headers })
    expect(list.json()).toMatchObject({
      users: [
        {
          user: { id: bot.userId },
          level: 'block',
          topReasons: [expect.stringMatching(/webdriver/)],
        },
      ],
    })
    const timeline = await api.app.inject({
      url: `/admin/risk/users/${bot.userId}/events`,
      headers: admin.headers,
    })
    expect(timeline.json<{ events: unknown[] }>().events).toHaveLength(1)

    const clear = await api.app.inject({
      method: 'POST',
      url: `/admin/users/${bot.userId}/clear`,
      headers: admin.headers,
    })
    expect(clear.statusCode).toBe(204)
    const after = await api.app.inject({ url: '/admin/risk/users', headers: admin.headers })
    expect(after.json()).toEqual({ users: [] })
  })

  it('is admin-only', async () => {
    const user = await signUp(api.app)
    const res = await api.app.inject({ url: '/admin/risk/users', headers: user.headers })
    expect(res.statusCode).toBe(403)
  })
})
