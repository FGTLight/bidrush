/** Small statistics helpers for the timing signals. */

export const mean = (xs: readonly number[]) =>
  xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length

export function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

/** Coefficient of variation: spread relative to the mean (scale-free). */
export function cv(xs: readonly number[]): number {
  const m = mean(xs)
  return m === 0 ? 0 : std(xs) / m
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2
}

/** Gaps between consecutive timestamps given newest first. */
export function intervals(timesNewestFirst: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < timesNewestFirst.length - 1; i++) {
    out.push((timesNewestFirst[i] ?? 0) - (timesNewestFirst[i + 1] ?? 0))
  }
  return out
}

/** Linear interpolation of `value` from [lo, hi] onto [0, 1], clamped. */
export function ramp(value: number, lo: number, hi: number): number {
  if (hi === lo) return value >= hi ? 1 : 0
  return Math.min(1, Math.max(0, (value - lo) / (hi - lo)))
}

/**
 * How well intervals fit a fixed clock: a timer firing every P ms that
 * sometimes skips (e.g. while already winning) produces gaps of P, 2P, 3P…
 * Returns the period and the RMS residual relative to it, or null when the
 * gaps don't look like multiples of one period.
 */
export function clockFit(
  gaps: readonly number[],
): { periodMs: number; relativeJitter: number } | null {
  const base = Math.min(...gaps)
  if (!Number.isFinite(base) || base < 50) return null
  const multiples = gaps.map((g) => Math.max(1, Math.round(g / base)))
  if (!multiples.some((k) => k > 1)) return null // plain regularity covers this case
  // Least-squares period for gaps ≈ k·P.
  const period =
    gaps.reduce((s, g, i) => s + g * (multiples[i] ?? 1), 0) /
    multiples.reduce((s, k) => s + k * k, 0)
  const residuals = gaps.map((g, i) => g - (multiples[i] ?? 1) * period)
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length)
  return { periodMs: period, relativeJitter: rms / period }
}
