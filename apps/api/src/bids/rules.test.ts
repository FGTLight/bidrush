import { describe, expect, it } from 'vitest'

import { type AuctionRulesState, minimumBid, rejectionReason, softCloseExtensionMs } from './rules'

const now = new Date('2026-10-07T12:00:00.000Z')
const inMs = (ms: number) => new Date(now.getTime() + ms)

const live: AuctionRulesState = {
  status: 'live',
  startingPrice: 100,
  minIncrement: 10,
  currentPrice: 150,
  leaderId: 'leader',
  endsAt: inMs(30_000),
}
const bid = { userId: 'me', amount: 160, userBlocked: false }

describe('minimumBid', () => {
  it('is the starting price before the first bid', () => {
    expect(minimumBid({ ...live, leaderId: null, currentPrice: 100 })).toBe(100)
  })

  it('is current price plus the increment afterwards', () => {
    expect(minimumBid(live)).toBe(160)
  })
})

describe('softCloseExtensionMs', () => {
  const rules = { windowMs: 5_000, extensionMs: 5_000, maxExtensionMs: 30_000, extendedMs: 0 }

  it('does nothing outside the closing window', () => {
    expect(softCloseExtensionMs({ ...rules, endsAt: inMs(5_001) }, now)).toBe(0)
  })

  it('extends a bid placed in the last seconds', () => {
    expect(softCloseExtensionMs({ ...rules, endsAt: inMs(5_000) }, now)).toBe(5_000)
    expect(softCloseExtensionMs({ ...rules, endsAt: inMs(1) }, now)).toBe(5_000)
  })

  it('caps the total extension', () => {
    expect(softCloseExtensionMs({ ...rules, endsAt: inMs(2_000), extendedMs: 27_000 }, now)).toBe(
      3_000,
    )
    expect(softCloseExtensionMs({ ...rules, endsAt: inMs(2_000), extendedMs: 30_000 }, now)).toBe(0)
  })

  it('caps at six extensions with the default rules', () => {
    let state = { ...rules, endsAt: inMs(1_000) }
    let total = 0
    for (let i = 0; i < 10; i++) {
      const ms = softCloseExtensionMs(state, state.endsAt)
      total += ms
      state = {
        ...state,
        extendedMs: state.extendedMs + ms,
        endsAt: new Date(state.endsAt.getTime() + ms),
      }
    }
    expect(total).toBe(30_000)
  })
})

describe('rejectionReason', () => {
  it.each<[string, AuctionRulesState | null, typeof bid, string]>([
    ['unknown auction', null, bid, 'AUCTION_NOT_FOUND'],
    ['blocked user', live, { ...bid, userBlocked: true }, 'BLOCKED'],
    ['not started', { ...live, status: 'scheduled' }, bid, 'AUCTION_NOT_LIVE'],
    ['ended status', { ...live, status: 'ended' }, bid, 'AUCTION_ENDED'],
    ['live but past its end', { ...live, endsAt: inMs(-1) }, bid, 'AUCTION_ENDED'],
    ['own leading bid', { ...live, leaderId: 'me' }, bid, 'SELF_OUTBID'],
    ['beaten to it', live, { ...bid, amount: 150 }, 'OUTBID'],
    ['below the increment', live, { ...bid, amount: 155 }, 'BID_TOO_LOW'],
    [
      'below the starting price',
      { ...live, leaderId: null, currentPrice: 100 },
      { ...bid, amount: 90 },
      'BID_TOO_LOW',
    ],
  ])('%s → %s', (_, auction, attempt, code) => {
    expect(rejectionReason(auction, attempt, now)).toBe(code)
  })
})
