/**
 * Per-connection message budget: `burst` messages at once, refilled at
 * `perSecond`. Cheap first line of defence against message floods; the
 * anti-bot engine adds per-user and per-IP limits on bids.
 */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst
    this.last = now()
  }

  /** Spends one token. Returns 0 when allowed, else ms until one is available. */
  take(): number {
    const now = this.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond)
    this.last = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return 0
    }
    return Math.ceil(((1 - this.tokens) / this.perSecond) * 1000)
  }
}
