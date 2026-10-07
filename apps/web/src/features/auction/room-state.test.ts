import type { Auction, Bid, ServerMessage } from '@bidrush/shared'

import {
  initialRoomState,
  minimumBid,
  myStatus,
  quickBidAmount,
  type RoomState,
  roomReducer,
} from './room-state'

const ID = '0b6f1f1e-6a55-4c3e-9a8e-6a1f6d2b9c01'
const ada = { id: '1b6f1f1e-6a55-4c3e-9a8e-6a1f6d2b9c01', displayName: 'Ada' }
const bob = { id: '2b6f1f1e-6a55-4c3e-9a8e-6a1f6d2b9c01', displayName: 'Bob' }

const auction: Auction = {
  id: ID,
  title: 'Camera',
  description: '',
  imageUrl: null,
  status: 'live',
  startingPrice: 100,
  minIncrement: 10,
  currentPrice: 100,
  leader: null,
  bidCount: 0,
  bidderCount: 0,
  startsAt: '2026-10-07T12:00:00.000Z',
  endsAt: '2026-10-07T12:01:00.000Z',
  extendedMs: 0,
}

const bid = (seq: number, bidder = ada, amount = 100 + seq * 10): Bid => ({
  id: `0000000${seq}-6a55-4c3e-9a8e-6a1f6d2b9c01`,
  auctionId: ID,
  bidder,
  amount,
  seq,
  createdAt: '2026-10-07T12:00:10.000Z',
})

const placed = (b: Bid, extended = false): ServerMessage => ({
  type: 'bid_placed',
  bid: b,
  currentPrice: b.amount,
  bidCount: b.seq,
  bidderCount: 2,
  endsAt: auction.endsAt,
  extendedMs: extended ? 5_000 : 0,
  extended,
})

const reduce = (messages: ServerMessage[], start: RoomState = initialRoomState) =>
  messages.reduce((s, message) => roomReducer(s, { type: 'server', message, at: 42 }), start)

const snapshot = (recentBids: Bid[] = [], a: Auction = auction): ServerMessage => ({
  type: 'auction_snapshot',
  auction: a,
  recentBids,
  serverTime: 0,
})

describe('roomReducer', () => {
  it('loads a snapshot, newest bid first', () => {
    const state = reduce([snapshot([bid(1), bid(2)])])
    expect(state.bids.map((b) => b.seq)).toEqual([2, 1])
    expect(state.lastSeq).toBe(2)
  })

  it('applies new bids and ignores stale or duplicate ones', () => {
    const state = reduce([
      snapshot(),
      placed(bid(1)),
      placed(bid(3, bob)),
      placed(bid(2)),
      placed(bid(3, bob)),
    ])
    expect(state.bids.map((b) => b.seq)).toEqual([3, 1])
    expect(state.auction).toMatchObject({ currentPrice: 130, leader: bob, bidCount: 3 })
  })

  it('a snapshot after a reconnect replaces the state (resync)', () => {
    const before = reduce([snapshot(), placed(bid(1))])
    const after = reduce(
      [snapshot([bid(1), bid(2, bob), bid(3)], { ...auction, currentPrice: 130, leader: ada })],
      before,
    )
    expect(after.bids.map((b) => b.seq)).toEqual([3, 2, 1])
    expect(after.auction?.currentPrice).toBe(130)
  })

  it('flags soft-close extensions', () => {
    expect(reduce([snapshot(), placed(bid(1), true)]).extendedAt).toBe(42)
  })

  it('reconciles a pending bid with its ack', () => {
    let state = reduce([snapshot()])
    state = roomReducer(state, { type: 'bid_sent', bid: { bidId: 'b1', amount: 110, sentAt: 1 } })
    expect(myStatus(state, ada.id)).toBe('pending')

    state = reduce(
      [{ type: 'bid_ack', status: 'rejected', bidId: 'b1', code: 'OUTBID', message: 'Too late' }],
      state,
    )
    expect(state.pending).toEqual([])
    expect(state.rejection).toMatchObject({ code: 'OUTBID' })
  })

  it('ends the auction with its winner', () => {
    const state = reduce([
      snapshot(),
      placed(bid(1)),
      {
        type: 'auction_ended',
        auctionId: ID,
        winner: ada,
        finalPrice: 110,
        endedAt: auction.endsAt,
      },
    ])
    expect(state.auction?.status).toBe('ended')
    expect(state.ended).toEqual({ winner: ada, finalPrice: 110 })
  })

  it('marks a missing auction as not found', () => {
    const state = reduce([{ type: 'error', code: 'AUCTION_NOT_FOUND', message: 'Nope' }])
    expect(state.notFound).toBe(true)
  })

  it('ignores events for other auctions', () => {
    const other = { ...bid(1), auctionId: '9b6f1f1e-6a55-4c3e-9a8e-6a1f6d2b9c01' }
    expect(reduce([snapshot(), placed(other)]).bids).toEqual([])
  })
})

describe('myStatus', () => {
  it('tells winning, outbid, won and lost apart', () => {
    const live = reduce([snapshot(), placed(bid(1)), placed(bid(2, bob))])
    expect(myStatus(live, bob.id)).toBe('winning')
    expect(myStatus(live, ada.id)).toBe('outbid')
    expect(myStatus(live, null)).toBe('guest')

    const ended = reduce(
      [
        {
          type: 'auction_ended',
          auctionId: ID,
          winner: bob,
          finalPrice: 120,
          endedAt: auction.endsAt,
        },
      ],
      live,
    )
    expect(myStatus(ended, bob.id)).toBe('won')
    expect(myStatus(ended, ada.id)).toBe('lost')
  })
})

describe('bid amounts', () => {
  it('starts at the starting price, then steps by the increment', () => {
    expect(minimumBid(auction)).toBe(100)
    const led = { ...auction, leader: ada, currentPrice: 150 }
    expect(minimumBid(led)).toBe(160)
    expect([1, 5, 10].map((s) => quickBidAmount(led, s))).toEqual([160, 200, 250])
  })
})
