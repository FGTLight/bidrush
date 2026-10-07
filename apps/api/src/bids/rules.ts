/**
 * Bid rules as pure functions. The database applies the same rules
 * atomically (see engine.ts); these versions explain rejections and are
 * unit-tested in isolation.
 */
import type { AuctionStatus, BidErrorCode } from '@bidrush/shared'

/** The fields of an auction the rules depend on. */
export interface AuctionRulesState {
  status: AuctionStatus
  startingPrice: number
  minIncrement: number
  currentPrice: number
  leaderId: string | null
  endsAt: Date
}

/** Lowest acceptable bid: the starting price, then current + increment. */
export function minimumBid(
  a: Pick<AuctionRulesState, 'startingPrice' | 'minIncrement' | 'currentPrice' | 'leaderId'>,
) {
  return a.leaderId === null ? a.startingPrice : a.currentPrice + a.minIncrement
}

export interface SoftClose {
  endsAt: Date
  windowMs: number
  extensionMs: number
  maxExtensionMs: number
  /** Extension already applied. */
  extendedMs: number
}

/** Mirror of the SQL function `soft_close_extension_ms`. */
export function softCloseExtensionMs(s: SoftClose, at: Date): number {
  if (s.endsAt.getTime() - at.getTime() > s.windowMs) return 0
  return Math.max(0, Math.min(s.extensionMs, s.maxExtensionMs - s.extendedMs))
}

/**
 * Why a bid that the atomic UPDATE refused was refused, in the order a
 * user would want to hear it. `null` means the bid should have passed: the
 * auction changed between the UPDATE and this check, so report OUTBID.
 */
export function rejectionReason(
  auction: AuctionRulesState | null,
  bid: { userId: string; amount: number; userBlocked: boolean },
  now: Date,
): BidErrorCode {
  if (!auction) return 'AUCTION_NOT_FOUND'
  if (bid.userBlocked) return 'BLOCKED'
  if (auction.status === 'scheduled') return 'AUCTION_NOT_LIVE'
  if (auction.status !== 'live' || auction.endsAt <= now) return 'AUCTION_ENDED'
  if (auction.leaderId === bid.userId) return 'SELF_OUTBID'
  if (bid.amount < minimumBid(auction)) {
    // Someone else already got to (or past) this amount: they were faster.
    return auction.leaderId !== null && bid.amount <= auction.currentPrice
      ? 'OUTBID'
      : 'BID_TOO_LOW'
  }
  return 'OUTBID'
}
