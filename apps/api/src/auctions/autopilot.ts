/**
 * Autopilot: keeps a rolling schedule of demo auctions so the site always
 * has something live (AUTOPILOT=true). Several instances may run it; a Redis
 * lock lets one of them act per round.
 */
import { inArray, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

import type { Config } from '../config'
import type { Db } from '../db/client'
import { auctions } from '../db/schema'
import { withLock } from '../realtime/lock'
import type { Redis } from '../redis'

/** Live + upcoming auctions to keep around. */
export const TARGET_ACTIVE = 6
/** Gap between consecutive starts, so endings are staggered. */
export const START_GAP_MS = 20_000

export const CATALOG = [
  ['Mechanical keyboard', 'Hot-swappable switches, aluminium case.', 120, 5],
  ['Retro handheld console', 'Plays the classics. Fits in a pocket.', 80, 5],
  ['Noise-cancelling headphones', '30 h battery, very quiet commute.', 200, 10],
  ['Signed vinyl record', 'First pressing, signed on the sleeve.', 50, 5],
  ['Espresso grinder', 'Stepless burr grinder for home baristas.', 150, 10],
  ['Vintage film camera', '35 mm rangefinder, serviced and tested.', 90, 5],
  ['Smartwatch', 'Heart rate, GPS, a week of battery.', 140, 10],
  ['Concert tickets (2)', 'Front-row pair for a sold-out show.', 60, 5],
  ['Drone with 4K camera', 'Folds to the size of a water bottle.', 250, 10],
  ['Designer desk lamp', 'Warm dimmable light, solid oak base.', 70, 5],
] as const

/**
 * Pure planning step: given the active auctions' start times, when should
 * the missing ones start?
 */
export function planStarts(activeStarts: readonly Date[], now: Date, missing: number): Date[] {
  const latest = Math.max(
    now.getTime() + 5_000,
    ...activeStarts.map((d) => d.getTime() + START_GAP_MS),
  )
  return Array.from({ length: missing }, (_, i) => new Date(latest + i * START_GAP_MS))
}

export async function topUpAuctions(db: Db, config: Config, now = new Date()): Promise<number> {
  const active = await db
    .select({ startsAt: auctions.startsAt })
    .from(auctions)
    .where(inArray(auctions.status, ['scheduled', 'live']))
  const missing = TARGET_ACTIVE - active.length
  if (missing <= 0) return 0

  const [{ n } = { n: 0 }] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from auctions`,
  )
  const starts = planStarts(
    active.map((a) => a.startsAt),
    now,
    missing,
  )
  await db.insert(auctions).values(
    starts.map((startsAt, i) => {
      const [title, description, startingPrice, minIncrement] =
        CATALOG[(n + i) % CATALOG.length] ?? CATALOG[0]
      return {
        title,
        description,
        startingPrice,
        minIncrement,
        currentPrice: startingPrice,
        startsAt,
        endsAt: new Date(startsAt.getTime() + config.auction.durationMs),
        softCloseWindowMs: config.auction.softCloseWindowMs,
        extensionMs: config.auction.extensionMs,
        maxExtensionMs: config.auction.maxExtensionMs,
      }
    }),
  )
  return missing
}

export function startAutopilot(deps: {
  db: Db
  redis: Redis
  config: Config
  log: FastifyBaseLogger
}) {
  const run = async () => {
    const result = await withLock(deps.redis, 'lock:autopilot', 10_000, () =>
      topUpAuctions(deps.db, deps.config),
    )
    if (result.acquired && result.value > 0) {
      deps.log.info({ created: result.value }, 'autopilot scheduled auctions')
    }
  }
  const timer = setInterval(() => {
    run().catch((err: unknown) => {
      deps.log.warn({ err }, 'autopilot failed')
    })
  }, 5_000)
  void run().catch(() => undefined)
  return () => {
    clearInterval(timer)
  }
}
