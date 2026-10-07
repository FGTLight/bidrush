/**
 * The bid engine: accepts or rejects one bid, atomically.
 *
 * One transaction, in this order:
 *   1. A conditional UPDATE of the auction row is the single decision point.
 *      Its WHERE clause holds every rule (live, not over, high enough, not
 *      already leading, not blocked) and Postgres evaluates it on the latest
 *      row version after taking the row lock, so concurrent bids on one
 *      auction are serialized and only valid ones change the price.
 *      `RETURNING old.*` (Postgres 18) yields the previous leader in the
 *      same statement: no second, race-prone read.
 *   2. The bid row is inserted with its sequence number.
 *   3. The bidder's credits are reserved and the previous leader's released.
 *      If the bidder can't afford it, the CHECK on the ledger aborts the
 *      whole transaction, including the price change.
 *
 * Idempotency: the client's bidId is the bids primary key. A retry of an
 * accepted bid finds it and gets the original answer back; it can never be
 * stored or reserved twice.
 */
import type { BidErrorCode, Wallet } from '@bidrush/shared'
import { bidErrorMessages } from '@bidrush/shared'
import { eq, sql } from 'drizzle-orm'

import type { Db, Tx } from '../db/client'
import { pgError } from '../db/errors'
import { auctionParticipants, auctions, bids, users } from '../db/schema'
import { getWallet, InsufficientCreditsError, releaseBid, reserveForBid } from '../ledger/ledger'
import { rejectionReason } from './rules'

export interface PlaceBidInput {
  bidId: string
  auctionId: string
  userId: string
  amount: number
}

export interface AcceptedBid {
  status: 'accepted'
  /** True when this bidId had already been accepted (a retry). */
  duplicate: boolean
  bid: {
    id: string
    auctionId: string
    userId: string
    amount: number
    seq: number
    createdAt: Date
  }
  auction: {
    currentPrice: number
    bidCount: number
    bidderCount: number
    endsAt: Date
    extendedMs: number
    /** This bid triggered a soft-close extension. */
    extended: boolean
  }
  /** Whose reservation was released, so they can be told they were outbid. */
  outbid: { userId: string; bidId: string; amount: number } | null
  wallet: Wallet
}

export interface RejectedBid {
  status: 'rejected'
  code: BidErrorCode
  message: string
}

export type PlaceBidResult = AcceptedBid | RejectedBid

const reject = (code: BidErrorCode): RejectedBid => ({
  status: 'rejected',
  code,
  message: bidErrorMessages[code],
})

/** What the atomic UPDATE returns: the new row plus the previous leader. */
interface UpdatedAuction extends Record<string, unknown> {
  current_price: number
  bid_count: number
  bidder_count: number
  ends_at: Date
  extended_ms: number
  extended: boolean
  previous_price: number
  previous_leader_id: string | null
  previous_bid_id: string | null
}

/**
 * The decision. Every rule is in the WHERE clause; clock_timestamp() is the
 * time when the row lock was obtained, not when the statement was queued.
 */
const acceptBidSql = (input: PlaceBidInput) => sql`
  UPDATE auctions AS a
  SET current_price  = ${input.amount},
      leader_id      = ${input.userId},
      leading_bid_id = ${input.bidId},
      bid_count      = a.bid_count + 1,
      (ends_at, extended_ms) = (
        SELECT a.ends_at + ext.ms * interval '1 millisecond', a.extended_ms + ext.ms
        FROM (SELECT soft_close_extension_ms(
                a.ends_at, clock_timestamp(), a.soft_close_window_ms,
                a.extension_ms, a.max_extension_ms, a.extended_ms) AS ms) AS ext
      )
  WHERE a.id = ${input.auctionId}
    AND a.status = 'live'
    AND a.ends_at > clock_timestamp()
    AND ${input.amount} >= CASE WHEN a.leader_id IS NULL THEN a.starting_price
                                ELSE a.current_price + a.min_increment END
    AND a.leader_id IS DISTINCT FROM ${input.userId}
    AND NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.id = ${input.userId} AND u.blocked_at IS NOT NULL)
  RETURNING a.current_price, a.bid_count, a.bidder_count, a.ends_at, a.extended_ms,
            new.extended_ms > old.extended_ms AS extended,
            old.current_price  AS previous_price,
            old.leader_id      AS previous_leader_id,
            old.leading_bid_id AS previous_bid_id
`

/** Thrown inside the transaction to roll it back with a typed reason. */
class Rejection extends Error {
  constructor(readonly result: RejectedBid) {
    super(result.code)
  }
}

async function acceptInTransaction(tx: Tx, input: PlaceBidInput): Promise<AcceptedBid | null> {
  const [updated] = await tx.execute<UpdatedAuction>(acceptBidSql(input))
  if (!updated) return null

  const [bid] = await tx
    .insert(bids)
    .values({
      id: input.bidId,
      auctionId: input.auctionId,
      userId: input.userId,
      amount: input.amount,
      seq: updated.bid_count,
    })
    .returning()
  if (!bid) throw new Error('bid not inserted')

  // Ledger: hold the new leader's credits, return the previous leader's.
  // Accounts are always locked in user-id order, so two bids that touch the
  // same pair of users in opposite roles can't deadlock.
  const reserve = () => reserveForBid(tx, input)
  const previous =
    updated.previous_leader_id && updated.previous_bid_id
      ? {
          userId: updated.previous_leader_id,
          bidId: updated.previous_bid_id,
          amount: updated.previous_price,
        }
      : null
  const release = async () => {
    if (previous) await releaseBid(tx, { ...previous, auctionId: input.auctionId })
  }
  if (previous && previous.userId < input.userId) {
    await release()
    await reserve()
  } else {
    await reserve()
    await release()
  }

  // Distinct bidders: count the user the first time they bid on this auction.
  const [participant] = await tx
    .insert(auctionParticipants)
    .values({
      auctionId: input.auctionId,
      userId: input.userId,
      highestBid: input.amount,
      lastBidAt: bid.createdAt,
    })
    .onConflictDoUpdate({
      target: [auctionParticipants.auctionId, auctionParticipants.userId],
      set: { highestBid: input.amount, lastBidAt: bid.createdAt },
    })
    .returning({ isNew: sql<boolean>`xmax = 0` })
  let bidderCount = updated.bidder_count
  if (participant?.isNew) {
    const [row] = await tx
      .update(auctions)
      .set({ bidderCount: sql`${auctions.bidderCount} + 1` })
      .where(eq(auctions.id, input.auctionId))
      .returning({ bidderCount: auctions.bidderCount })
    bidderCount = row?.bidderCount ?? bidderCount + 1
  }

  return {
    status: 'accepted',
    duplicate: false,
    bid: {
      id: bid.id,
      auctionId: bid.auctionId,
      userId: bid.userId,
      amount: bid.amount,
      seq: bid.seq,
      createdAt: bid.createdAt,
    },
    auction: {
      currentPrice: updated.current_price,
      bidCount: updated.bid_count,
      bidderCount,
      endsAt: new Date(updated.ends_at),
      extendedMs: updated.extended_ms,
      extended: updated.extended,
    },
    outbid: previous,
    wallet: await getWallet(tx, input.userId),
  }
}

/** The answer to a retried bidId: the original result, or a mismatch. */
async function replay(db: Db, input: PlaceBidInput): Promise<PlaceBidResult | null> {
  const [existing] = await db.select().from(bids).where(eq(bids.id, input.bidId))
  if (!existing) return null
  if (existing.userId !== input.userId || existing.auctionId !== input.auctionId) {
    // Someone reusing another bid's id: never reveal or touch that bid.
    return reject('VALIDATION')
  }
  const [auction] = await db.select().from(auctions).where(eq(auctions.id, input.auctionId))
  if (!auction) return reject('AUCTION_NOT_FOUND')
  return {
    status: 'accepted',
    duplicate: true,
    bid: {
      id: existing.id,
      auctionId: existing.auctionId,
      userId: existing.userId,
      amount: existing.amount,
      seq: existing.seq,
      createdAt: existing.createdAt,
    },
    auction: {
      currentPrice: auction.currentPrice,
      bidCount: auction.bidCount,
      bidderCount: auction.bidderCount,
      endsAt: auction.endsAt,
      extendedMs: auction.extendedMs,
      extended: false,
    },
    // Nothing new happened, so nobody new was outbid.
    outbid: null,
    wallet: await getWallet(db, input.userId),
  }
}

/** Explains a refusal by re-reading the auction (outside the hot path). */
async function explainRejection(db: Db, input: PlaceBidInput): Promise<RejectedBid> {
  const [[auction], [user]] = await Promise.all([
    db.select().from(auctions).where(eq(auctions.id, input.auctionId)),
    db.select({ blockedAt: users.blockedAt }).from(users).where(eq(users.id, input.userId)),
  ])
  return reject(
    rejectionReason(
      auction ?? null,
      { userId: input.userId, amount: input.amount, userBlocked: Boolean(user?.blockedAt) },
      new Date(),
    ),
  )
}

const RETRYABLE = new Set(['40P01', '40001']) // deadlock, serialization failure

export async function placeBid(db: Db, input: PlaceBidInput): Promise<PlaceBidResult> {
  // No "already seen?" lookup up front: a retry of an accepted bid can never
  // pass the conditional UPDATE (it is no longer above the price, or it is
  // the leader's own bid), and the bids primary key would stop it anyway.
  // Retries are recognised on the rejection path instead, keeping the hot
  // path to the minimum number of queries.
  for (let attempt = 1; ; attempt++) {
    try {
      const accepted = await db.transaction(async (tx) => {
        const result = await acceptInTransaction(tx, input)
        if (!result) throw new Rejection(reject('OUTBID')) // refined below
        return result
      })
      return accepted
    } catch (error) {
      if (error instanceof Rejection) {
        // A concurrent copy of this very bid may have won the race.
        return (await replay(db, input)) ?? explainRejection(db, input)
      }
      if (error instanceof InsufficientCreditsError) return reject('INSUFFICIENT_CREDITS')
      const pg = pgError(error)
      if (pg?.code === '23505' && pg.constraint_name === 'bids_pkey') {
        // Same bidId committed by a concurrent request a moment ago.
        return (await replay(db, input)) ?? reject('VALIDATION')
      }
      if (pg?.code === '23503') return reject('AUCTION_NOT_FOUND') // unknown user/auction
      if (pg?.code === '22P02') return reject('VALIDATION') // malformed uuid
      if (pg && RETRYABLE.has(pg.code) && attempt < 3) continue
      throw error
    }
  }
}
