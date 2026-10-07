/** Combining signals into one decision. Pure: no I/O. */
import type { RiskLevel } from '@bidrush/shared'

import type { AntiBotConfig } from './config'
import { automation, inconsistency } from './signals/browser'
import { bidRate, honeypot, noInteraction, sharedDevice } from './signals/behavior'
import { closingCluster, intervalRegularity, reactionSpeed } from './signals/timing'
import { ramp } from './stats'
import type { BidContext, Decision, ScoredSignal, Signal } from './types'

/** The registered detectors. Adding one is adding it here. */
export const SIGNALS: readonly Signal[] = [
  honeypot,
  automation,
  inconsistency,
  intervalRegularity,
  reactionSpeed,
  closingCluster,
  bidRate,
  noInteraction,
  sharedDevice,
]

export function scoreSignals(
  ctx: BidContext,
  config: AntiBotConfig,
  signals: readonly Signal[] = SIGNALS,
): ScoredSignal[] {
  return signals
    .map((s) => ({ name: s.name, ...s.evaluate(ctx, config) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
}

/**
 * Noisy-OR: the probability that at least one detector is right, treating
 * them as independent. Weak signals add up; one strong signal dominates;
 * the result stays in [0, 1].
 */
export function combine(scores: readonly number[]): number {
  return 1 - scores.reduce((p, s) => p * (1 - Math.min(1, Math.max(0, s))), 1)
}

/**
 * A user's risk doesn't reset with every bid: the previous score decays
 * with a half-life, so a bot caught once stays suspect for a while, and a
 * one-off false positive fades.
 */
export function withMemory(
  current: number,
  previous: { score: number; atMs: number } | null,
  nowMs: number,
  halfLifeMs: number,
): number {
  if (!previous) return current
  const decayed = previous.score * 0.5 ** (Math.max(0, nowMs - previous.atMs) / halfLifeMs)
  return Math.max(current, decayed)
}

export function levelFor(score: number, { thresholds }: AntiBotConfig): RiskLevel {
  if (score >= thresholds.block) return 'block'
  if (score >= thresholds.challenge) return 'challenge'
  if (score >= thresholds.throttle) return 'throttle'
  return 'allow'
}

/**
 * The action for a score. A solved proof-of-work challenge downgrades
 * "challenge" to "throttle" for a while; nothing downgrades "block".
 */
export function decide(
  score: number,
  signals: ScoredSignal[],
  config: AntiBotConfig,
  { hasPass }: { hasPass: boolean },
): Decision {
  let level = levelFor(score, config)
  if (level === 'challenge' && hasPass) level = 'throttle'
  const { thresholds, throttleDelayMs } = config
  const delayMs =
    level === 'throttle'
      ? Math.round(
          throttleDelayMs.min +
            (throttleDelayMs.max - throttleDelayMs.min) *
              ramp(score, thresholds.throttle, thresholds.challenge),
        )
      : 0
  return { score, level, signals, delayMs }
}
