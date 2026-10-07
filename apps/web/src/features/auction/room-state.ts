/**
 * The auction room's state as a pure reducer, fed by server messages and
 * local intents. Rules:
 *  - A snapshot replaces everything known about the auction (resync).
 *  - A bid event older than the last one seen is ignored: events from
 *    different API instances can arrive out of order; `seq` is the truth.
 *  - Bids the user sent are "pending" until the server acknowledges them.
 *    Accepted bids then show up through the broadcast like everyone else's.
 */
import type {
  Auction,
  AuctionSnapshot,
  Bid,
  BidAck,
  BidErrorCode,
  BidPlaced,
  PublicUser,
  ServerMessage,
} from '@bidrush/shared'

export const FEED_SIZE = 50

export interface PendingBid {
  bidId: string
  amount: number
  sentAt: number
  /** The server asked for proof-of-work; the client is solving it. */
  verifying?: boolean
}

export interface RoomState {
  auction: Auction | null
  /** Newest first. */
  bids: Bid[]
  lastSeq: number
  pending: PendingBid[]
  rejection: { code: BidErrorCode; message: string; at: number } | null
  /** When the last soft-close extension happened (for the banner). */
  extendedAt: number | null
  ended: { winner: PublicUser | null; finalPrice: number } | null
  /** The server says this auction doesn't exist. */
  notFound: boolean
}

export const initialRoomState: RoomState = {
  auction: null,
  bids: [],
  lastSeq: 0,
  pending: [],
  rejection: null,
  extendedAt: null,
  ended: null,
  notFound: false,
}

export type RoomAction =
  | { type: 'server'; message: ServerMessage; at: number }
  /**
   * First paint from REST, before the WebSocket snapshot. Ignored once
   * anything live has arrived: an HTTP response may be older than events.
   */
  | { type: 'initial'; snapshot: AuctionSnapshot }
  | { type: 'bid_sent'; bid: PendingBid }
  | { type: 'dismiss_rejection' }

function applySnapshot(state: RoomState, m: AuctionSnapshot): RoomState {
  const bids = [...m.recentBids].sort((a, b) => b.seq - a.seq).slice(0, FEED_SIZE)
  return {
    ...state,
    auction: m.auction,
    bids,
    lastSeq: bids[0]?.seq ?? 0,
    ended:
      m.auction.status === 'ended'
        ? { winner: m.auction.leader, finalPrice: m.auction.currentPrice }
        : null,
  }
}

function applyBidPlaced(state: RoomState, m: BidPlaced, at: number): RoomState {
  if (!state.auction || m.bid.auctionId !== state.auction.id) return state
  if (m.bid.seq <= state.lastSeq) return state // stale or duplicate
  return {
    ...state,
    auction: {
      ...state.auction,
      currentPrice: m.currentPrice,
      leader: m.bid.bidder,
      bidCount: m.bidCount,
      bidderCount: m.bidderCount,
      endsAt: m.endsAt,
      extendedMs: m.extendedMs,
    },
    bids: [m.bid, ...state.bids].slice(0, FEED_SIZE),
    lastSeq: m.bid.seq,
    extendedAt: m.extended ? at : state.extendedAt,
  }
}

function applyAck(state: RoomState, m: BidAck, at: number): RoomState {
  if (!state.pending.some((p) => p.bidId === m.bidId)) return state
  if (m.status === 'rejected' && m.code === 'CHALLENGE_REQUIRED') {
    // Not final: the client solves the challenge and resends this bid.
    return {
      ...state,
      pending: state.pending.map((p) => (p.bidId === m.bidId ? { ...p, verifying: true } : p)),
    }
  }
  const pending = state.pending.filter((p) => p.bidId !== m.bidId)
  if (m.status === 'accepted') return { ...state, pending, rejection: null }
  return { ...state, pending, rejection: { code: m.code, message: m.message, at } }
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'bid_sent':
      return { ...state, pending: [...state.pending, action.bid], rejection: null }
    case 'dismiss_rejection':
      return { ...state, rejection: null }
    case 'initial':
      return state.auction ? state : applySnapshot(state, action.snapshot)
    case 'server': {
      const m = action.message
      switch (m.type) {
        case 'auction_snapshot':
          return state.auction && m.auction.id !== state.auction.id
            ? state
            : applySnapshot(state, m)
        case 'bid_placed':
          return applyBidPlaced(state, m, action.at)
        case 'bid_ack':
          return applyAck(state, m, action.at)
        case 'auction_started':
          return state.auction?.id === m.auction.id ? { ...state, auction: m.auction } : state
        case 'error':
          // Only meaningful before the room has loaded.
          return !state.auction && m.code === 'AUCTION_NOT_FOUND'
            ? { ...state, notFound: true }
            : state
        case 'auction_ended':
          if (state.auction?.id !== m.auctionId) return state
          return {
            ...state,
            auction: {
              ...state.auction,
              status: 'ended',
              leader: m.winner,
              currentPrice: m.finalPrice,
            },
            ended: { winner: m.winner, finalPrice: m.finalPrice },
            pending: [],
          }
        default:
          return state
      }
    }
  }
}

export type MyStatus = 'guest' | 'idle' | 'pending' | 'winning' | 'outbid' | 'won' | 'lost'

/** How the room looks from the user's seat. */
export function myStatus(state: RoomState, userId: string | null): MyStatus {
  if (!userId) return 'guest'
  const { auction } = state
  if (!auction) return 'idle'
  const leading = auction.leader?.id === userId
  const participated = leading || state.bids.some((b) => b.bidder.id === userId)
  if (auction.status === 'ended') return leading ? 'won' : participated ? 'lost' : 'idle'
  if (state.pending.length > 0) return 'pending'
  if (leading) return 'winning'
  return participated ? 'outbid' : 'idle'
}

/** Lowest acceptable bid right now. */
export function minimumBid(auction: Auction): number {
  return auction.leader ? auction.currentPrice + auction.minIncrement : auction.startingPrice
}

/** Quick-bid buttons: +1, +5 or +10 increments over the minimum step. */
export function quickBidAmount(auction: Auction, steps: number): number {
  return minimumBid(auction) + (steps - 1) * auction.minIncrement
}
