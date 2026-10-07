/**
 * Timing signals, measured on the server: a script can lie about its
 * browser, but not about when its messages arrive.
 */
import { clockFit, cv, intervals, median, ramp, std } from '../stats'
import { clean, type Signal } from '../types'

/**
 * Metronome-like bidding: intervals with almost no variation, or intervals
 * that are all multiples of one fixed period (a timer that skips ticks).
 */
export const intervalRegularity: Signal = {
  name: 'interval_regularity',
  evaluate(ctx, { timing }) {
    const gaps = intervals([ctx.nowMs, ...ctx.recentBidTimes]).slice(0, 10)
    if (gaps.length < timing.minIntervals) return clean

    const variation = cv(gaps)
    // Below robotCv → 1; at suspiciousCv → 0.
    const steady = 1 - ramp(variation, timing.robotCv, timing.suspiciousCv)
    const fit = clockFit(gaps)
    const clock = fit ? 1 - ramp(fit.relativeJitter, timing.clockJitter, timing.clockJitter * 3) : 0

    if (steady === 0 && clock === 0) return clean
    if (steady >= clock) {
      const avg = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)
      return {
        score: steady,
        reason: `${gaps.length} bids every ~${avg} ms with ${(variation * 100).toFixed(1)}% variation (humans vary far more)`,
      }
    }
    return {
      score: clock,
      reason: `${gaps.length} bids on a fixed ~${Math.round(fit?.periodMs ?? 0)} ms clock (every gap a multiple of it, ±${((fit?.relativeJitter ?? 0) * 100).toFixed(1)}%)`,
    }
  },
}

/** Reacting to being outbid faster than a human can see and click. */
export const reactionSpeed: Signal = {
  name: 'reaction_speed',
  evaluate(ctx, { timing }) {
    const samples = ctx.reactionTimes.slice(0, 8)
    if (samples.length < timing.minReactions) return clean
    const m = median(samples)
    const score = 1 - ramp(m, timing.robotReactionMs, timing.suspiciousReactionMs)
    if (score === 0) return clean
    return {
      score,
      reason: `median ${Math.round(m)} ms to answer being outbid over ${samples.length} times (human reaction ≥ ~250 ms)`,
    }
  },
}

/** Sniping scripts fire at the same offset before the close, every time. */
export const closingCluster: Signal = {
  name: 'closing_cluster',
  evaluate(ctx, { timing }) {
    const offsets = ctx.closingOffsets.slice(0, 8)
    if (offsets.length < timing.minClosingBids) return clean
    const spread = std(offsets)
    const score = 1 - ramp(spread, timing.clusterStdMs / 2, timing.clusterStdMs * 2)
    if (score === 0) return clean
    return {
      score: score * 0.9,
      reason: `${offsets.length} bids at ${Math.round(median(offsets))} ± ${Math.round(spread)} ms before the close`,
    }
  },
}
