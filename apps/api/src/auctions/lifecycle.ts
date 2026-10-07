/**
 * Auction lifecycle: scheduled → live → ended.
 *
 * Every API instance runs the same scheduler loop; correctness never
 * depends on there being exactly one. Each transition is a conditional
 * UPDATE that only one transaction can win:
 *
 *   start: status = 'scheduled' AND starts_at <= now  →  'live'
 *   close: status = 'live'      AND ends_at   <= now  →  'ended' + settle
 *
 * A bid racing the close is serialized with it on the auction row lock: a
 * bid that lands in the soft-close window moves ends_at forward first, and
 * the close's WHERE then no longer matches. The Redis lock in front of the
 * close only avoids duplicate work; Postgres (and the settle-once index in
 * the ledger) is the guarantee.
 */
import type { PublicUser } from '@bidrush/shared'
import { eq, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

import type { Db } from '../db/client'
import { auctions, users } from '../db/schema'
import { getWallet, settleAuction } from '../ledger/ledger'
import { auctionChannel, type Broker, LOBBY_CHANNEL, userChannel } from '../realtime/broker'
import { withLock } from '../realtime/lock'
import type { Redis } from '../redis'
import { getAuction } from './views'

export interface ClosedAuction {
  auctionId: string
  winner: PublicUser | null
  finalPrice: number
  endedAt: Date
}

/** Moves every due scheduled auction to live. Returns the ids started here. */
export async function startDueAuctions(db: Db): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE auctions SET status = 'live'
    WHERE status = 'scheduled' AND starts_at <= clock_timestamp()
    RETURNING id
  `)
  return rows.map((r) => r.id)
}

/**
 * Ends one auction and settles the winner's credits, in one transaction.
 * Returns null when the auction is not due (or another instance closed it).
 */
export async function closeAuction(db: Db, auctionId: string): Promise<ClosedAuction | null> {
  return db.transaction(async (tx) => {
    const [ended] = await tx.execute<{
      leader_id: string | null
      current_price: number
      ended_at: Date
    }>(sql`
      UPDATE auctions SET status = 'ended', ended_at = clock_timestamp()
      WHERE id = ${auctionId} AND status = 'live' AND ends_at <= clock_timestamp()
      RETURNING leader_id, current_price, ended_at
    `)
    if (!ended) return null

    let winner: PublicUser | null = null
    if (ended.leader_id) {
      await settleAuction(tx, {
        userId: ended.leader_id,
        auctionId,
        amount: ended.current_price,
      })
      const [user] = await tx
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, ended.leader_id))
      winner = user ?? null
    }
    await tx
      .update(auctions)
      .set({ settledAt: sql`clock_timestamp()` })
      .where(eq(auctions.id, auctionId))

    return {
      auctionId,
      winner,
      finalPrice: ended.current_price,
      endedAt: new Date(ended.ended_at),
    }
  })
}

export async function dueToClose(db: Db, limit = 50): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM auctions
    WHERE status = 'live' AND ends_at <= clock_timestamp()
    ORDER BY ends_at
    LIMIT ${limit}
  `)
  return rows.map((r) => r.id)
}

interface SchedulerDeps {
  db: Db
  redis: Redis
  broker: Broker
  log: FastifyBaseLogger
  /** How often to look for due auctions. */
  tickMs?: number
}

/**
 * Polls for due transitions and broadcasts them. A short poll (250 ms) is
 * simpler and more robust than per-auction timers across instances, and
 * clients count down from `endsAt` anyway; the close is at most one tick late.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly tickMs: number

  constructor(private readonly deps: SchedulerDeps) {
    this.tickMs = deps.tickMs ?? 250
  }

  start() {
    this.running = true
    this.schedule()
  }

  async stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule() {
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err: unknown) => {
          this.deps.log.error({ err }, 'scheduler tick failed')
        })
        .finally(() => {
          this.schedule()
        })
    }, this.tickMs)
  }

  /** One pass; exposed so tests can drive the scheduler deterministically. */
  async tick() {
    const { db, broker } = this.deps
    for (const id of await startDueAuctions(db)) {
      const auction = await getAuction(db, id)
      if (!auction) continue
      const message = { type: 'auction_started', auction } as const
      await Promise.all([
        broker.publish(auctionChannel(id), message),
        broker.publish(LOBBY_CHANNEL, message),
      ])
    }
    for (const id of await dueToClose(db)) await this.close(id)
  }

  private async close(auctionId: string) {
    const { db, redis, broker, log } = this.deps
    const run = () => closeAuction(db, auctionId)
    // Redis down? Close anyway: the conditional UPDATE is the guarantee.
    const locked = await withLock(redis, `lock:auction:${auctionId}:close`, 10_000, run).catch(
      async () => ({ acquired: true as const, value: await run() }),
    )
    if (!locked.acquired || !locked.value) return
    const closed = locked.value

    log.info(
      { auctionId, winner: closed.winner?.id, finalPrice: closed.finalPrice },
      'auction ended',
    )
    const message = {
      type: 'auction_ended',
      auctionId,
      winner: closed.winner,
      finalPrice: closed.finalPrice,
      endedAt: closed.endedAt.toISOString(),
    } as const
    await Promise.all([
      broker.publish(auctionChannel(auctionId), message),
      broker.publish(LOBBY_CHANNEL, message),
      closed.winner &&
        broker.publish(userChannel(closed.winner.id), {
          type: 'wallet',
          wallet: await getWallet(db, closed.winner.id),
        }),
    ])
  }
}
