/**
 * Load test: hundreds of real WebSocket clients bidding through nginx on
 * both API instances, measuring throughput and latency percentiles.
 *
 *   ANTIBOT_MODE=monitor docker compose up -d --build
 *   pnpm load-test
 *
 * Run the stack with ANTIBOT_MODE=monitor: the engine still evaluates (and
 * stores) every bid, so its cost is included, but it doesn't throttle or
 * block the load generator, which looks exactly like a bot farm.
 *
 * Accounts and sessions are created straight in Postgres (the sign-up rate
 * limit would otherwise make this take minutes), so JWT_SECRET and
 * DATABASE_URL must match the stack's.
 *
 * Env: LOAD_CLIENTS (300), LOAD_AUCTIONS (5), LOAD_SECONDS (30),
 * LOAD_BID_INTERVAL_MS (1500, average per client), BIDRUSH_URL.
 */
import { randomUUID } from 'node:crypto'

import { serverMessageSchema } from '@bidrush/shared'
import WebSocket from 'ws'

import { createSession } from '../apps/api/src/auth/sessions'
import { createDb } from '../apps/api/src/db/client'
import { auctions, users } from '../apps/api/src/db/schema'
import { grantCredits, openAccounts } from '../apps/api/src/ledger/ledger'

const BASE = process.env.BIDRUSH_URL ?? 'http://localhost:8080'
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://bidrush:bidrush@localhost:5432/bidrush'
const JWT_SECRET = process.env.JWT_SECRET ?? 'local-compose-secret-change-me-0123456789'
const CLIENTS = Number(process.env.LOAD_CLIENTS ?? 300)
const AUCTIONS = Number(process.env.LOAD_AUCTIONS ?? 5)
const SECONDS = Number(process.env.LOAD_SECONDS ?? 30)
const INTERVAL_MS = Number(process.env.LOAD_BID_INTERVAL_MS ?? 1_500)
const RUN = Date.now().toString(36)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function percentiles(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const at = (p: number) =>
    s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? 0
  return { p50: at(50), p95: at(95), p99: at(99), max: s.at(-1) ?? 0 }
}

async function setUp() {
  const { db, close } = createDb(DATABASE_URL, { max: 10 })
  console.log(`creating ${CLIENTS} accounts and ${AUCTIONS} auctions…`)
  const now = Date.now()
  const created = await db
    .insert(auctions)
    .values(
      Array.from({ length: AUCTIONS }, (_, i) => ({
        title: `Load test ${RUN} #${i + 1}`,
        status: 'live' as const,
        startingPrice: 1,
        minIncrement: 1,
        currentPrice: 1,
        startsAt: new Date(now - 1_000),
        endsAt: new Date(now + (SECONDS + 120) * 1_000),
        softCloseWindowMs: 5_000,
        extensionMs: 5_000,
        maxExtensionMs: 30_000,
      })),
    )
    .returning({ id: auctions.id })

  const cookies: string[] = []
  // Small batches: argon2 isn't needed (no password sign-in), sessions are.
  for (let i = 0; i < CLIENTS; i += 25) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(25, CLIENTS - i) }, (_, j) =>
        db.transaction(async (tx) => {
          const [user] = await tx
            .insert(users)
            .values({
              email: `load-${RUN}-${i + j}@bidrush.dev`,
              passwordHash: 'load-test-no-password',
              displayName: `Load ${i + j}`,
            })
            .returning({ id: users.id })
          if (!user) throw new Error('user not created')
          await openAccounts(tx, user.id)
          await grantCredits(tx, user.id, 1_000_000, 'Load test credits')
          const session = await createSession(tx, {
            userId: user.id,
            ttlMs: 3_600_000,
            secret: JWT_SECRET,
          })
          return `bidrush_session=${session.token}`
        }),
      ),
    )
    cookies.push(...batch)
  }
  await close()
  return { auctionIds: created.map((a) => a.id), cookies }
}

async function main() {
  const { auctionIds, cookies } = await setUp()
  const sentAt = new Map<string, number>()
  const ackLatency: number[] = []
  const broadcastLatency: number[] = []
  const broadcastSeen = new Set<string>()
  let accepted = 0
  let rejected = 0
  const rejectCodes = new Map<string, number>()
  let errors = 0

  console.log(`opening ${CLIENTS} WebSockets via ${WS_URL}…`)
  const clients = await Promise.all(
    cookies.map(async (cookie, i) => {
      const auctionId = auctionIds[i % auctionIds.length] ?? ''
      const ws = new WebSocket(WS_URL, { headers: { origin: BASE, cookie } })
      const state = { ws, auctionId, price: 1, leading: false, userId: '' }
      ws.on('message', (raw: Buffer) => {
        const parsed = serverMessageSchema.safeParse(JSON.parse(raw.toString()))
        if (!parsed.success) return
        const m = parsed.data
        const now = performance.now()
        if (m.type === 'welcome') state.userId = m.userId ?? ''
        else if (m.type === 'auction_snapshot') state.price = m.auction.currentPrice
        else if (m.type === 'bid_placed') {
          state.price = m.currentPrice
          state.leading = m.bid.bidder.id === state.userId
          // First delivery to any *other* client = broadcast latency.
          const t = sentAt.get(m.bid.id)
          if (t !== undefined && m.bid.bidder.id !== state.userId && !broadcastSeen.has(m.bid.id)) {
            broadcastSeen.add(m.bid.id)
            broadcastLatency.push(now - t)
          }
        } else if (m.type === 'bid_ack') {
          const t = sentAt.get(m.bidId)
          if (t !== undefined) ackLatency.push(now - t)
          if (m.status === 'accepted') accepted += 1
          else {
            rejected += 1
            rejectCodes.set(m.code, (rejectCodes.get(m.code) ?? 0) + 1)
          }
        }
      })
      ws.on('error', () => {
        errors += 1
      })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => {
          resolve()
        })
        ws.once('error', reject)
      })
      ws.send(
        JSON.stringify({
          type: 'hello',
          signals: {
            userAgent: 'BidRush load test',
            webdriver: false,
            languages: ['en'],
            timezone: 'UTC',
            timezoneOffset: 0,
          },
        }),
      )
      ws.send(JSON.stringify({ type: 'subscribe', auctionId }))
      return state
    }),
  )

  console.log(
    `bidding for ${SECONDS} s (~${Math.round((CLIENTS * 1_000) / INTERVAL_MS)} bids/s offered)…`,
  )
  const startedAt = performance.now()
  const deadline = Date.now() + SECONDS * 1_000
  await Promise.all(
    clients.map(async (c) => {
      await sleep(Math.random() * INTERVAL_MS) // spread the start
      while (Date.now() < deadline) {
        if (!c.leading) {
          const bidId = randomUUID()
          sentAt.set(bidId, performance.now())
          c.ws.send(
            JSON.stringify({
              type: 'bid',
              bidId,
              auctionId: c.auctionId,
              amount: c.price + 1 + Math.floor(Math.random() * 3),
              interaction: { trustedEvents: 1, honeypot: '', reactionMs: 500 },
            }),
          )
        }
        await sleep(INTERVAL_MS * (0.5 + Math.random()))
      }
    }),
  )
  await sleep(2_000) // drain acks
  const elapsedS = (performance.now() - startedAt) / 1_000
  for (const c of clients) c.ws.close()

  const ack = percentiles(ackLatency)
  const broadcast = percentiles(broadcastLatency)
  const total = accepted + rejected
  const fmt = (n: number) => `${n.toFixed(1)} ms`
  console.log(`
## Load test (${new Date().toISOString().slice(0, 10)})

${CLIENTS} WebSocket clients · ${AUCTIONS} live auctions · ${SECONDS} s · 2 API instances behind nginx · anti-bot in monitor mode

| Metric | Value |
| --- | --- |
| Bids processed | ${total} (${(total / elapsedS).toFixed(0)} bids/s) |
| Accepted / rejected | ${accepted} / ${rejected} (${[...rejectCodes].map(([c, n]) => `${c} ${n}`).join(', ') || '-'}) |
| Bid → ack latency | p50 ${fmt(ack.p50)} · p95 ${fmt(ack.p95)} · p99 ${fmt(ack.p99)} · max ${fmt(ack.max)} |
| Bid → broadcast to another client | p50 ${fmt(broadcast.p50)} · p95 ${fmt(broadcast.p95)} · p99 ${fmt(broadcast.p99)} |
| Socket errors | ${errors} |
`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
