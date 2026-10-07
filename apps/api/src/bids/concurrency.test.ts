/**
 * The bid engine under contention: 1,000 bids from 200 users against one
 * auction, in two shapes. Whatever the interleaving, the invariants in
 * `expectAuctionInvariants` must hold.
 *
 * Seeded randomness: CONCURRENCY_SEED=7 pnpm test replays a run.
 */
import { randomUUID } from 'node:crypto'

import { asc, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createAuction,
  createUser,
  expectLedgerConsistent,
  resetDb,
  useTestDb,
} from '../../test/db'
import { auctions, bids, ledgerAccounts } from '../db/schema'
import { type PlaceBidResult, placeBid } from './engine'

// A bigger pool than the API's default, to maximise real parallelism.
const { db } = useTestDb(50)
beforeEach(() => resetDb(db))

const USERS = 200
const BIDS_PER_USER = 5
const STARTING_PRICE = 100
const INCREMENT = 10
const ALLOWED_REJECTIONS = ['OUTBID', 'BID_TOO_LOW', 'SELF_OUTBID', 'INSUFFICIENT_CREDITS']

/** Deterministic pseudo-random numbers, so a failure can be replayed. */
function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31
    return s / 2 ** 31
  }
}

async function setUp(random: () => number) {
  const auction = await createAuction(db, {
    startingPrice: STARTING_PRICE,
    minIncrement: INCREMENT,
    currentPrice: STARTING_PRICE,
    endsAt: new Date(Date.now() + 10 * 60_000),
  })
  // Varied budgets: some users can't afford the higher bids, so
  // INSUFFICIENT_CREDITS races with everything else.
  const granted = new Map<string, number>()
  const people = await Promise.all(
    Array.from({ length: USERS }, async () => {
      const credits = 5_000 + Math.floor(random() * 45_000)
      const user = await createUser(db, { credits })
      granted.set(user.id, credits)
      return user
    }),
  )
  return { auction, people, granted }
}

function summarize(label: string, results: PlaceBidResult[], elapsedMs: number) {
  const accepted = results.filter((r) => r.status === 'accepted').length
  const codes = new Map<string, number>()
  for (const r of results) {
    if (r.status === 'rejected') codes.set(r.code, (codes.get(r.code) ?? 0) + 1)
  }
  console.info(
    `${label}: ${results.length} bids in ${elapsedMs.toFixed(0)} ms, ${accepted} accepted; ` +
      [...codes].map(([c, n]) => `${c} ${n}`).join(', '),
  )
}

async function expectAuctionInvariants(
  auctionId: string,
  granted: Map<string, number>,
  results: PlaceBidResult[],
) {
  // Every bid got a definite answer, and only expected rejections.
  expect(results).toHaveLength(USERS * BIDS_PER_USER)
  const accepted = results.filter((r) => r.status === 'accepted')
  expect(accepted.length).toBeGreaterThan(0)
  for (const r of results) {
    if (r.status === 'rejected') expect(ALLOWED_REJECTIONS).toContain(r.code)
  }

  // The price history: gapless sequence, strictly increasing by at least
  // the increment, in commit order.
  const history = await db
    .select()
    .from(bids)
    .where(eq(bids.auctionId, auctionId))
    .orderBy(asc(bids.seq))
  expect(history).toHaveLength(accepted.length)
  history.forEach((bid, i) => {
    expect(bid.seq).toBe(i + 1)
    const prev = history[i - 1]
    if (prev) {
      expect(bid.amount).toBeGreaterThanOrEqual(prev.amount + INCREMENT)
      expect(bid.createdAt.getTime()).toBeGreaterThanOrEqual(prev.createdAt.getTime())
    }
  })

  // Exactly one winner: the last accepted bid, at the current price.
  const last = history.at(-1)!
  const [final] = await db.select().from(auctions).where(eq(auctions.id, auctionId))
  expect(final).toMatchObject({
    leaderId: last.userId,
    leadingBidId: last.id,
    currentPrice: last.amount,
    bidCount: history.length,
    bidderCount: new Set(history.map((b) => b.userId)).size,
  })

  // Exactly one live reservation: the leader's, for the current price.
  const reserved = await db
    .select({ userId: ledgerAccounts.userId, balance: ledgerAccounts.balance })
    .from(ledgerAccounts)
    .where(sql`${ledgerAccounts.kind} = 'reserved' and ${ledgerAccounts.balance} > 0`)
  expect(reserved).toEqual([{ userId: last.userId, balance: last.amount }])

  // Nobody gained or lost credits: available + reserved = what they were given.
  const totals = await db
    .select({ userId: ledgerAccounts.userId, total: sql<string>`sum(${ledgerAccounts.balance})` })
    .from(ledgerAccounts)
    .where(sql`${ledgerAccounts.userId} is not null`)
    .groupBy(ledgerAccounts.userId)
  expect(totals).toHaveLength(granted.size)
  for (const t of totals) expect(Number(t.total)).toBe(granted.get(t.userId!))

  // One reservation per accepted bid, and all but the leader's released.
  const [counts] = await db.execute<{ reserves: string; releases: string }>(sql`
    select count(*) filter (where kind = 'reserve') as reserves,
           count(*) filter (where kind = 'release') as releases
    from ledger_transactions
  `)
  expect(Number(counts?.reserves)).toBe(history.length)
  expect(Number(counts?.releases)).toBe(history.length - 1)

  // No negative balance, every transaction balanced, ledger sums to zero.
  await expectLedgerConsistent(db)
}

const seed = Number(process.env.CONCURRENCY_SEED ?? 42)

describe('1,000 bids from 200 users on one auction', () => {
  it('burst: all 1,000 fired at the same instant', { timeout: 120_000 }, async () => {
    const random = rng(seed)
    const { auction, people, granted } = await setUp(random)

    const attempts = people.flatMap((person) =>
      Array.from({ length: BIDS_PER_USER }, () => ({
        bidId: randomUUID(),
        auctionId: auction.id,
        userId: person.id,
        amount: STARTING_PRICE + INCREMENT * Math.floor(random() * 4_000),
      })),
    )

    const started = performance.now()
    const results = await Promise.all(attempts.map((a) => placeBid(db, a)))
    summarize('burst', results, performance.now() - started)
    await expectAuctionInvariants(auction.id, granted, results)
  })

  it(
    'reactive: 200 bidders racing to top the price they just saw',
    { timeout: 120_000 },
    async () => {
      const random = rng(seed + 1)
      const { auction, people, granted } = await setUp(random)

      // Each bidder reads the price and bids just above it, five times, while
      // 199 others do the same: many bids collide on the same few amounts.
      const bidder = async (userId: string) => {
        const results: PlaceBidResult[] = []
        for (let i = 0; i < BIDS_PER_USER; i++) {
          const [row] = await db
            .select({ price: auctions.currentPrice })
            .from(auctions)
            .where(eq(auctions.id, auction.id))
          const steps = 1 + Math.floor(random() * 3)
          results.push(
            await placeBid(db, {
              bidId: randomUUID(),
              auctionId: auction.id,
              userId,
              amount: row!.price + INCREMENT * steps,
            }),
          )
        }
        return results
      }

      const started = performance.now()
      const results = (await Promise.all(people.map((p) => bidder(p.id)))).flat()
      summarize('reactive', results, performance.now() - started)
      await expectAuctionInvariants(auction.id, granted, results)
    },
  )
})
