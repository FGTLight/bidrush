import { auctionListQuery, createAuctionBody } from '@bidrush/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { authOf, requireAdmin } from '../auth/plugin'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { auctions } from '../db/schema'
import { HttpError } from '../errors'
import { getAuction, listAuctions, recentBids } from './views'

const idParams = z.object({ id: z.uuid() })

export async function auctionRoutes(
  app: FastifyInstance,
  { config, db }: { config: Config; db: Db },
) {
  app.get('/auctions', async (req) => {
    const query = auctionListQuery.parse(req.query)
    return {
      auctions: await listAuctions(db, query.status, query.limit),
      serverTime: Date.now(),
    }
  })

  app.get('/auctions/:id', async (req) => {
    const { id } = idParams.parse(req.params)
    const auction = await getAuction(db, id)
    if (!auction) throw new HttpError(404, 'AUCTION_NOT_FOUND', 'This auction does not exist.')
    return { auction, recentBids: await recentBids(db, id), serverTime: Date.now() }
  })

  app.post('/admin/auctions', { preHandler: requireAdmin }, async (req, reply) => {
    const body = createAuctionBody.parse(req.body)
    const startsAt = new Date(body.startsAt)
    const durationMs = body.durationMs ?? config.auction.durationMs
    const [row] = await db
      .insert(auctions)
      .values({
        title: body.title,
        description: body.description,
        imageUrl: body.imageUrl,
        startingPrice: body.startingPrice,
        minIncrement: body.minIncrement,
        currentPrice: body.startingPrice,
        startsAt,
        endsAt: new Date(startsAt.getTime() + durationMs),
        // The current soft-close rules are frozen into the auction.
        softCloseWindowMs: config.auction.softCloseWindowMs,
        extensionMs: config.auction.extensionMs,
        maxExtensionMs: config.auction.maxExtensionMs,
        createdBy: authOf(req).userId,
      })
      .returning({ id: auctions.id })
    if (!row) throw new Error('auction not created')
    req.log.info({ auctionId: row.id }, 'auction created')
    return reply.status(201).send({ auction: await getAuction(db, row.id) })
  })
}
