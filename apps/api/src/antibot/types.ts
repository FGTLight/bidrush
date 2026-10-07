import type { BrowserSignals, InteractionSignals, RiskLevel } from '@bidrush/shared'

import type { AntiBotConfig } from './config'

/**
 * Everything known about a bid attempt when it is scored. Gathered by the
 * engine (one Redis round trip); signals only read it, so they are pure
 * functions and trivially unit-testable.
 */
export interface BidContext {
  userId: string
  auctionId: string
  ip: string
  /** Server time when the bid arrived. */
  nowMs: number
  interaction: InteractionSignals
  /** From the connection's `hello`; null if the client never sent one. */
  browser: BrowserSignals | null
  /** Server-computed device fingerprint; null without browser signals. */
  fingerprint: string | null
  /** Distinct accounts seen on this fingerprint in the last day (including this one). */
  accountsOnDevice: number
  /** Arrival times of this user's previous bid attempts, newest first. */
  recentBidTimes: number[]
  /** Server-measured: ms from "you were outbid" to the user's next bid, newest first. */
  reactionTimes: number[]
  /** Time left on the clock for the user's recent bids placed near the close. */
  closingOffsets: number[]
  rate: {
    userPerSecond: number
    userPerMinute: number
    ipPerMinute: number
    devicePerMinute: number
  }
}

export interface SignalResult {
  /** 0 = looks human, 1 = certainly automated. */
  score: number
  /** Human-readable, shown to admins. Empty when the signal found nothing. */
  reason: string
}

/** A pluggable detector. Add one by implementing this and listing it in the engine. */
export interface Signal {
  name: string
  evaluate(ctx: BidContext, config: AntiBotConfig): SignalResult
}

export interface ScoredSignal extends SignalResult {
  name: string
}

export interface Decision {
  /** Combined risk of this attempt, after memory. */
  score: number
  level: RiskLevel
  signals: ScoredSignal[]
  /** For throttled bids. */
  delayMs: number
}

export const clean: SignalResult = { score: 0, reason: '' }
