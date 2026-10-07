import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createAuction,
  createUser,
  expectLedgerConsistent,
  resetDb,
  useTestDb,
} from '../../test/db'
import { auctions, bids, users } from '../db/schema'
import { getWallet } from '../ledger/ledger'
import { type PlaceBidResult, placeBid } from './engine'

const { db } = useTestDb()
beforeEach(() => resetDb(db))

const bidOn = (auctionId: string, userId: string, amount: number, bidId = randomUUID()) =>
  placeBid(db, { bidId, auctionId, userId, amount })

const codeOf = (r: PlaceBidResult) => (r.status === 'rejected' ? r.code : 'ACCEPTED')

async function auctionRow(id: string) {
  const [row] = await db.select().from(auctions).where(eq(auctions.id, id))
  return row!
}

describe('accepting bids', () => {
  it('accepts an opening bid at the starting price and reserves the credits', async () => {
    const auction = await createAuction(db, { startingPrice: 100, minIncrement: 10 })
    const ada = await createUser(db, { credits: 1_000 })

    const result = await bidOn(auction.id, ada.id, 100)
    expect(result).toMatchObject({
      status: 'accepted',
      duplicate: false,
      bid: { amount: 100, seq: 1 },
      auction: { currentPrice: 100, bidCount: 1, bidderCount: 1, extended: false },
      outbid: null,
      wallet: { available: 900, reserved: 100 },
    })
    expect(await auctionRow(auction.id)).toMatchObject({ leaderId: ada.id, currentPrice: 100 })
    await expectLedgerConsistent(db)
  })

  it('moves the reservation to the new leader', async () => {
    const auction = await createAuction(db, { startingPrice: 100, minIncrement: 10 })
    const ada = await createUser(db, { credits: 1_000 })
    const bob = await createUser(db, { credits: 1_000 })

    const first = await bidOn(auction.id, ada.id, 100)
    const second = await bidOn(auction.id, bob.id, 110)

    expect(second).toMatchObject({
      status: 'accepted',
      bid: { seq: 2 },
      auction: { currentPrice: 110, bidCount: 2, bidderCount: 2 },
      outbid: { userId: ada.id, amount: 100 },
    })
    expect(
      first.status === 'accepted' && second.status === 'accepted' && second.outbid?.bidId,
    ).toBe(first.status === 'accepted' ? first.bid.id : null)
    expect(await getWallet(db, ada.id)).toEqual({ available: 1_000, reserved: 0 })
    expect(await getWallet(db, bob.id)).toEqual({ available: 890, reserved: 110 })
    await expectLedgerConsistent(db)
  })

  it('counts a returning bidder once', async () => {
    const auction = await createAuction(db)
    const ada = await createUser(db, { credits: 1_000 })
    const bob = await createUser(db, { credits: 1_000 })
    await bidOn(auction.id, ada.id, 100)
    await bidOn(auction.id, bob.id, 110)
    const third = await bidOn(auction.id, ada.id, 120)
    expect(third).toMatchObject({ auction: { bidCount: 3, bidderCount: 2 } })
  })
})

describe('rejecting bids', () => {
  it('rejects bids below the minimum', async () => {
    const auction = await createAuction(db, { startingPrice: 100, minIncrement: 10 })
    const ada = await createUser(db, { credits: 1_000 })
    const bob = await createUser(db, { credits: 1_000 })

    expect(codeOf(await bidOn(auction.id, ada.id, 99))).toBe('BID_TOO_LOW')
    await bidOn(auction.id, ada.id, 100)
    expect(codeOf(await bidOn(auction.id, bob.id, 105))).toBe('BID_TOO_LOW')
    expect(codeOf(await bidOn(auction.id, bob.id, 100))).toBe('OUTBID')
  })

  it('does not let the leader outbid themselves', async () => {
    const auction = await createAuction(db)
    const ada = await createUser(db, { credits: 1_000 })
    await bidOn(auction.id, ada.id, 100)
    expect(codeOf(await bidOn(auction.id, ada.id, 200))).toBe('SELF_OUTBID')
    expect(await getWallet(db, ada.id)).toEqual({ available: 900, reserved: 100 })
  })

  it('rejects unaffordable bids without changing the auction', async () => {
    const auction = await createAuction(db, { startingPrice: 100 })
    const poor = await createUser(db, { credits: 150 })

    expect(codeOf(await bidOn(auction.id, poor.id, 200))).toBe('INSUFFICIENT_CREDITS')
    // The price change was rolled back with the failed reservation.
    expect(await auctionRow(auction.id)).toMatchObject({
      currentPrice: 100,
      leaderId: null,
      bidCount: 0,
    })
    expect(await db.select().from(bids)).toHaveLength(0)
    await expectLedgerConsistent(db)
  })

  it.each([
    ['scheduled', { status: 'scheduled' as const }, 'AUCTION_NOT_LIVE'],
    ['ended', { status: 'ended' as const }, 'AUCTION_ENDED'],
    [
      'live but past its end',
      { startsAt: new Date(Date.now() - 120_000), endsAt: new Date(Date.now() - 1) },
      'AUCTION_ENDED',
    ],
  ])('rejects bids on a %s auction', async (_, overrides, code) => {
    const auction = await createAuction(db, overrides)
    const ada = await createUser(db, { credits: 1_000 })
    expect(codeOf(await bidOn(auction.id, ada.id, 500))).toBe(code)
  })

  it('rejects blocked users', async () => {
    const auction = await createAuction(db)
    const ada = await createUser(db, { credits: 1_000 })
    await db.update(users).set({ blockedAt: new Date() }).where(eq(users.id, ada.id))
    expect(codeOf(await bidOn(auction.id, ada.id, 100))).toBe('BLOCKED')
  })

  it('rejects unknown auctions', async () => {
    const ada = await createUser(db, { credits: 1_000 })
    expect(codeOf(await bidOn(randomUUID(), ada.id, 100))).toBe('AUCTION_NOT_FOUND')
  })
})

describe('soft close', () => {
  it('extends the auction when a bid lands in the closing window', async () => {
    const endsAt = new Date(Date.now() + 3_000)
    const auction = await createAuction(db, { endsAt })
    const ada = await createUser(db, { credits: 1_000 })

    const result = await bidOn(auction.id, ada.id, 100)
    expect(result).toMatchObject({ auction: { extended: true, extendedMs: 5_000 } })
    expect((await auctionRow(auction.id)).endsAt.getTime()).toBe(endsAt.getTime() + 5_000)
  })

  it('does not extend earlier bids', async () => {
    const auction = await createAuction(db, { endsAt: new Date(Date.now() + 20_000) })
    const ada = await createUser(db, { credits: 1_000 })
    expect(await bidOn(auction.id, ada.id, 100)).toMatchObject({
      auction: { extended: false, extendedMs: 0 },
    })
  })

  it('never extends past the maximum', async () => {
    const auction = await createAuction(db, {
      endsAt: new Date(Date.now() + 2_000),
      extendedMs: 28_000,
    })
    const ada = await createUser(db, { credits: 1_000 })
    const bob = await createUser(db, { credits: 1_000 })
    expect(await bidOn(auction.id, ada.id, 100)).toMatchObject({
      auction: { extended: true, extendedMs: 30_000 },
    })
    // Still inside the window, but the budget is spent.
    expect(await bidOn(auction.id, bob.id, 110)).toMatchObject({
      auction: { extended: false, extendedMs: 30_000 },
    })
  })
})

describe('idempotency', () => {
  it('turns 10 concurrent copies of one bid into one bid and one reservation', async () => {
    const auction = await createAuction(db)
    const ada = await createUser(db, { credits: 1_000 })
    const bidId = randomUUID()

    const results = await Promise.all(
      Array.from({ length: 10 }, () => bidOn(auction.id, ada.id, 300, bidId)),
    )

    expect(results.every((r) => r.status === 'accepted')).toBe(true)
    expect(results.filter((r) => r.status === 'accepted' && !r.duplicate)).toHaveLength(1)
    expect(await db.select().from(bids)).toHaveLength(1)
    expect(await auctionRow(auction.id)).toMatchObject({ bidCount: 1, currentPrice: 300 })
    expect(await getWallet(db, ada.id)).toEqual({ available: 700, reserved: 300 })
    await expectLedgerConsistent(db)
  })

  it('answers a later retry with the original result', async () => {
    const auction = await createAuction(db)
    const ada = await createUser(db, { credits: 1_000 })
    const bob = await createUser(db, { credits: 1_000 })
    const bidId = randomUUID()
    await bidOn(auction.id, ada.id, 100, bidId)
    await bidOn(auction.id, bob.id, 150) // Ada is outbid meanwhile.

    const retry = await bidOn(auction.id, ada.id, 100, bidId)
    expect(retry).toMatchObject({ status: 'accepted', duplicate: true, bid: { id: bidId, seq: 1 } })
    expect(await getWallet(db, ada.id)).toEqual({ available: 1_000, reserved: 0 })
  })

  it('refuses a bid id that belongs to someone else', async () => {
    const auction = await createAuction(db)
    const ada = await createUser(db, { credits: 1_000 })
    const mallory = await createUser(db, { credits: 1_000 })
    const bidId = randomUUID()
    await bidOn(auction.id, ada.id, 100, bidId)
    expect(codeOf(await bidOn(auction.id, mallory.id, 500, bidId))).toBe('VALIDATION')
  })
})
