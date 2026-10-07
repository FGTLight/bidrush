import { z } from 'zod'

/**
 * Anti-bot thresholds. Every number that decides how a user is treated
 * lives here, documented, overridable from the environment so it can be
 * tuned without a deploy (start in `monitor` mode to calibrate).
 */
const envSchema = z.object({
  /** enforce: act on decisions · monitor: log only (shadow mode) · off */
  ANTIBOT_MODE: z.enum(['enforce', 'monitor', 'off']).default('enforce'),
  ANTIBOT_THROTTLE_AT: z.coerce.number().min(0).max(1).default(0.35),
  ANTIBOT_CHALLENGE_AT: z.coerce.number().min(0).max(1).default(0.6),
  ANTIBOT_BLOCK_AT: z.coerce.number().min(0).max(1).default(0.85),
  /** Leading zero hex digits in sha256(prefix + nonce): 4 ≈ 65k hashes. */
  ANTIBOT_POW_DIFFICULTY: z.coerce.number().int().min(1).max(6).default(4),
  /**
   * Bids per minute from one IP before it counts as a signal. Generous on
   * purpose: offices, campuses and mobile carriers put many people behind
   * one address (NAT), so per-IP rates are weak evidence.
   */
  ANTIBOT_IP_PER_MINUTE: z.coerce.number().int().min(1).default(300),
})

export type AntiBotConfig = ReturnType<typeof loadAntiBotConfig>

export function loadAntiBotConfig(env: Record<string, string | undefined> = process.env) {
  const e = envSchema.parse(env)
  return {
    mode: e.ANTIBOT_MODE,
    thresholds: {
      throttle: e.ANTIBOT_THROTTLE_AT,
      challenge: e.ANTIBOT_CHALLENGE_AT,
      block: e.ANTIBOT_BLOCK_AT,
    },
    /** Delay added to a throttled bid, scaled with the score inside the band. */
    throttleDelayMs: { min: 250, max: 1_500 },
    /** A user's risk decays with this half-life once they behave. */
    memoryHalfLifeMs: 5 * 60_000,
    challenge: { difficulty: e.ANTIBOT_POW_DIFFICULTY, ttlMs: 60_000, passMs: 2 * 60_000 },
    /** Repeated block decisions in this window block the account itself. */
    autoBlock: { decisions: 3, windowMs: 10 * 60_000 },
    rate: {
      /** Hard limit: above it the bid is refused (RATE_LIMITED), not just scored. */
      userPerSecondHard: 5,
      userPerSecond: 2,
      userPerMinute: 40,
      ipPerMinute: e.ANTIBOT_IP_PER_MINUTE,
      devicePerMinute: 60,
    },
    timing: {
      /** Intervals needed before judging regularity. */
      minIntervals: 5,
      /**
       * Coefficient of variation of the intervals: full score at robotCv, none
       * from suspiciousCv up. Scripts measure ~0.5%; people well above 25%,
       * but 10 samples are noisy, so the band stays far below human range
       * (the simulator flagged a human at 19% with a 20% cut-off).
       */
      robotCv: 0.05,
      suspiciousCv: 0.12,
      /** RMS distance from a fixed clock, relative to its period: full score at this. */
      clockJitter: 0.02,
      /** Median reaction to being outbid. Human visual reaction is ~250 ms at best. */
      robotReactionMs: 150,
      suspiciousReactionMs: 250,
      minReactions: 3,
      /** Bids placed this close to the end are checked for identical offsets. */
      closingWindowMs: 10_000,
      clusterStdMs: 60,
      minClosingBids: 3,
    },
    devices: { suspiciousAccounts: 3, farmAccounts: 6 },
  }
}
