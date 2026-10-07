/** Read models: database rows → the shared `Auction` / `Bid` shapes. */
import type { Auction, Bid } from '@bidrush/shared'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { Executor } from '../db/client'
import { auctions, bids, users } from '../db/schema'

const leader = alias(users, 'leader')

const auctionColumns = {
  auction: auctions,
  leaderName: leader.displayName,
}

type AuctionRow = { auction: typeof auctions.$inferSelect; leaderName: string | null }

export function toAuction({ auction: a, leaderName }: AuctionRow): Auction {
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    imageUrl: a.imageUrl,
    status: a.status,
    startingPrice: a.startingPrice,
    minIncrement: a.minIncrement,
    currentPrice: a.currentPrice,
    leader: a.leaderId && leaderName ? { id: a.leaderId, displayName: leaderName } : null,
    bidCount: a.bidCount,
    bidderCount: a.bidderCount,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    extendedMs: a.extendedMs,
  }
}

export async function getAuction(ex: Executor, id: string): Promise<Auction | null> {
  const [row] = await ex
    .select(auctionColumns)
    .from(auctions)
    .leftJoin(leader, eq(leader.id, auctions.leaderId))
    .where(eq(auctions.id, id))
  return row ? toAuction(row) : null
}

/**
 * `active` = live auctions ending soonest first, then upcoming ones by
 * start time: what the lobby grid shows.
 */
export async function listAuctions(
  ex: Executor,
  status: Auction['status'] | 'active',
  limit: number,
): Promise<Auction[]> {
  const statuses: Auction['status'][] = status === 'active' ? ['live', 'scheduled'] : [status]
  const rows = await ex
    .select(auctionColumns)
    .from(auctions)
    .leftJoin(leader, eq(leader.id, auctions.leaderId))
    .where(inArray(auctions.status, statuses))
    .orderBy(
      sql`case ${auctions.status} when 'live' then 0 else 1 end`,
      status === 'ended' ? desc(auctions.endsAt) : asc(auctions.endsAt),
    )
    .limit(limit)
  return rows.map(toAuction)
}

export async function recentBids(ex: Executor, auctionId: string, limit = 50): Promise<Bid[]> {
  const rows = await ex
    .select({ bid: bids, name: users.displayName })
    .from(bids)
    .innerJoin(users, eq(users.id, bids.userId))
    .where(and(eq(bids.auctionId, auctionId)))
    .orderBy(desc(bids.seq))
    .limit(limit)
  return rows.map(({ bid, name }) => ({
    id: bid.id,
    auctionId: bid.auctionId,
    bidder: { id: bid.userId, displayName: name },
    amount: bid.amount,
    seq: bid.seq,
    createdAt: bid.createdAt.toISOString(),
  }))
}
