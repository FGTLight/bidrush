import type { Auction } from '@bidrush/shared'
import { desc, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'

import { authOf, requireUser } from '../auth/plugin'
import { toAuction } from '../auctions/views'
import type { Db } from '../db/client'
import { auctionParticipants, auctions, users } from '../db/schema'
import { getLedgerHistory, getWallet } from '../ledger/ledger'

const leader = alias(users, 'leader')

export async function meRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.addHook('preHandler', requireUser)

  app.get('/me/wallet', async (req) => {
    const { userId } = authOf(req)
    const [wallet, ledger] = await Promise.all([
      getWallet(db, userId),
      getLedgerHistory(db, userId, 100),
    ])
    return { wallet, ledger }
  })

  /** Auctions the user bid on, most recent activity first. */
  app.get('/me/bids', async (req) => {
    const { userId } = authOf(req)
    const rows = await db
      .select({
        auction: auctions,
        leaderName: leader.displayName,
        myHighestBid: auctionParticipants.highestBid,
      })
      .from(auctionParticipants)
      .innerJoin(auctions, eq(auctions.id, auctionParticipants.auctionId))
      .leftJoin(leader, eq(leader.id, auctions.leaderId))
      .where(eq(auctionParticipants.userId, userId))
      .orderBy(desc(auctionParticipants.lastBidAt))
      .limit(100)

    return {
      items: rows.map((r) => {
        const auction: Auction = toAuction(r)
        return {
          auction,
          myHighestBid: r.myHighestBid,
          // Leading a live auction, or the winner of an ended one.
          winning: r.auction.leaderId === userId && r.auction.status !== 'cancelled',
        }
      }),
    }
  })
}
