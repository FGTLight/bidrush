import { inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { testConfig } from '../../test/app'
import { createAuction, resetDb, useTestDb } from '../../test/db'
import { auctions } from '../db/schema'
import { planStarts, START_GAP_MS, TARGET_ACTIVE, topUpAuctions } from './autopilot'

const { db } = useTestDb()
beforeEach(() => resetDb(db))

describe('planStarts', () => {
  it('staggers new auctions after the last active one', () => {
    const now = new Date('2026-10-07T12:00:00Z')
    const last = new Date('2026-10-07T12:01:00Z')
    expect(planStarts([last], now, 2)).toEqual([
      new Date(last.getTime() + START_GAP_MS),
      new Date(last.getTime() + 2 * START_GAP_MS),
    ])
  })

  it('starts soon when nothing is active', () => {
    const now = new Date('2026-10-07T12:00:00Z')
    expect(planStarts([], now, 1)).toEqual([new Date(now.getTime() + 5_000)])
  })
})

describe('topUpAuctions', () => {
  it('fills the schedule up to the target, once', async () => {
    await createAuction(db) // one live already
    const config = testConfig()
    expect(await topUpAuctions(db, config)).toBe(TARGET_ACTIVE - 1)
    expect(await topUpAuctions(db, config)).toBe(0)
    const active = await db
      .select()
      .from(auctions)
      .where(inArray(auctions.status, ['live', 'scheduled']))
    expect(active).toHaveLength(TARGET_ACTIVE)
    // Endings are staggered.
    const ends = active.map((a) => a.endsAt.getTime()).sort()
    expect(new Set(ends).size).toBe(TARGET_ACTIVE)
  })
})
