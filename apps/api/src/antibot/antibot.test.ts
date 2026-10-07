/** Unit tests: every signal and the scoring are pure functions. */
import { describe, expect, it } from 'vitest'

import { loadAntiBotConfig } from './config'
import { combine, decide, levelFor, scoreSignals, withMemory } from './score'
import { automation, inconsistency, zoneOffsetMinutes } from './signals/browser'
import { bidRate, honeypot, noInteraction, sharedDevice } from './signals/behavior'
import { closingCluster, intervalRegularity, reactionSpeed } from './signals/timing'
import type { BidContext } from './types'

const config = loadAntiBotConfig({})
const NOW = Date.parse('2026-07-07T12:00:00Z')

/** A clearly human context; tests change one thing at a time. */
function human(overrides: Partial<BidContext> = {}): BidContext {
  return {
    userId: 'u',
    auctionId: 'a',
    ip: '203.0.113.7',
    nowMs: NOW,
    interaction: { trustedEvents: 3, honeypot: '', reactionMs: 900 },
    browser: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36',
      webdriver: false,
      languages: ['es-ES', 'en'],
      timezone: 'Europe/Madrid',
      timezoneOffset: -120, // CEST in July
      screen: { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1 },
      hardwareConcurrency: 8,
      touchPoints: 0,
    },
    fingerprint: 'fp',
    accountsOnDevice: 1,
    // Irregular gaps: 4.1 s, 1.3 s, 9.8 s, 2.2 s, 6 s.
    recentBidTimes: [NOW - 4_100, NOW - 5_400, NOW - 15_200, NOW - 17_400, NOW - 23_400],
    reactionTimes: [820, 1_400, 650],
    closingOffsets: [3_200, 900, 4_100],
    rate: { userPerSecond: 1, userPerMinute: 6, ipPerMinute: 6, devicePerMinute: 6 },
    ...overrides,
  }
}

describe('a normal human', () => {
  it('triggers nothing and is allowed', () => {
    const signals = scoreSignals(human(), config)
    expect(signals).toEqual([])
    expect(decide(combine([]), signals, config, { hasPass: false }).level).toBe('allow')
  })
})

describe('timing signals', () => {
  it('flags metronome-regular bidding', () => {
    const times = Array.from({ length: 8 }, (_, i) => NOW - (i + 1) * 1_000 + (i % 2) * 3)
    const r = intervalRegularity.evaluate(human({ recentBidTimes: times }), config)
    expect(r.score).toBe(1)
    expect(r.reason).toMatch(/every ~1000 ms/)
  })

  it('flags a fixed clock that skips ticks (gaps of 800, 1600, 2400 ms)', () => {
    const gaps = [800, 1_600, 800, 2_400, 803, 1_597, 799, 1_602]
    let t = NOW
    const times = gaps.map((g) => (t -= g))
    const r = intervalRegularity.evaluate(human({ recentBidTimes: times }), config)
    expect(r.score).toBe(1)
    expect(r.reason).toMatch(/fixed ~800 ms clock/)
  })

  it('does not see a clock in human timing', () => {
    // Uniform 0.7–2.6 s reaction delays, like the simulated humans.
    const gaps = [1_843, 912, 2_377, 1_210, 765, 2_044, 1_498, 2_581]
    let t = NOW
    const times = gaps.map((g) => (t -= g))
    expect(intervalRegularity.evaluate(human({ recentBidTimes: times }), config).score).toBe(0)
  })

  it('needs enough intervals before judging', () => {
    const times = [NOW - 1_000, NOW - 2_000]
    expect(intervalRegularity.evaluate(human({ recentBidTimes: times }), config).score).toBe(0)
  })

  it('flags superhuman reactions to being outbid', () => {
    expect(reactionSpeed.evaluate(human({ reactionTimes: [60, 75, 58, 90] }), config).score).toBe(1)
    expect(
      reactionSpeed.evaluate(human({ reactionTimes: [200, 210, 190] }), config).score,
    ).toBeGreaterThan(0)
    expect(reactionSpeed.evaluate(human({ reactionTimes: [60, 70] }), config).score).toBe(0) // too few
  })

  it('flags bids clustered at the same offset before closing', () => {
    const r = closingCluster.evaluate(
      human({ closingOffsets: [1_500, 1_510, 1_495, 1_505] }),
      config,
    )
    expect(r.score).toBeGreaterThan(0.8)
    expect(r.reason).toMatch(/1503 ± \d+ ms before the close/)
  })
})

describe('behaviour signals', () => {
  it('scores rates relative to their limits', () => {
    expect(bidRate.evaluate(human(), config).score).toBe(0)
    const flood = bidRate.evaluate(
      human({
        rate: { userPerSecond: 6, userPerMinute: 30, ipPerMinute: 10, devicePerMinute: 10 },
      }),
      config,
    )
    expect(flood.score).toBe(1)
    expect(flood.reason).toMatch(/bids\/s from this account/)
  })

  it('treats a filled honeypot as conclusive', () => {
    const ctx = human({
      interaction: { trustedEvents: 5, honeypot: 'http://spam', reactionMs: 900 },
    })
    expect(honeypot.evaluate(ctx, config).score).toBe(1)
    expect(levelFor(combine(scoreSignals(ctx, config).map((s) => s.score)), config)).toBe('block')
  })

  it('notices bids without real input events', () => {
    const ctx = human({ interaction: { trustedEvents: 0, honeypot: '', reactionMs: null } })
    expect(noInteraction.evaluate(ctx, config).score).toBeGreaterThan(0)
  })

  it('escalates with the number of accounts on one device', () => {
    expect(sharedDevice.evaluate(human({ accountsOnDevice: 2 }), config).score).toBe(0)
    expect(sharedDevice.evaluate(human({ accountsOnDevice: 3 }), config).score).toBeCloseTo(0.4)
    expect(sharedDevice.evaluate(human({ accountsOnDevice: 10 }), config).score).toBeCloseTo(0.9)
  })
})

describe('browser signals', () => {
  it('flags webdriver, headless user agents and skipped handshakes', () => {
    const base = human().browser!
    expect(
      automation.evaluate(human({ browser: { ...base, webdriver: true } }), config).score,
    ).toBe(0.95)
    expect(
      automation.evaluate(
        human({ browser: { ...base, userAgent: 'Mozilla/5.0 HeadlessChrome/141.0' } }),
        config,
      ).score,
    ).toBe(0.9)
    expect(automation.evaluate(human({ browser: null }), config).score).toBe(0.5)
  })

  it('computes zone offsets like getTimezoneOffset', () => {
    expect(zoneOffsetMinutes('Europe/Madrid', new Date(NOW))).toBe(-120)
    expect(zoneOffsetMinutes('America/Havana', new Date(NOW))).toBe(240)
    expect(zoneOffsetMinutes('UTC', new Date(NOW))).toBe(0)
    expect(zoneOffsetMinutes('Not/AZone')).toBeNull()
  })

  it('flags contradictions between reported facts', () => {
    const base = human().browser!
    const r = inconsistency.evaluate(
      human({
        browser: {
          ...base,
          timezoneOffset: 0, // claims Madrid, clock says UTC
          languages: [],
          screen: { width: 0, height: 0, colorDepth: 24, pixelRatio: 1 },
        },
      }),
      config,
    )
    expect(r.score).toBeCloseTo(0.65)
    expect(r.reason).toMatch(/doesn't match.*no browser languages/)
  })

  it('counts a zero-size window once, not as two signals', () => {
    const base = human().browser!
    const ctx = human({
      browser: {
        ...base,
        headlessHints: ['zero-outer-size'],
        screen: { width: 0, height: 0, colorDepth: 24, pixelRatio: 1 },
      },
    })
    const signals = scoreSignals(ctx, config)
    expect(signals).toEqual([
      { name: 'automation', score: 0.25, reason: 'headless hints: zero-outer-size' },
    ])
    expect(levelFor(combine(signals.map((s) => s.score)), config)).toBe('allow')
  })
})

describe('combining and deciding', () => {
  it('adds weak signals up and lets a strong one dominate', () => {
    expect(combine([0.3, 0.3])).toBeCloseTo(0.51)
    expect(combine([0.95, 0.1])).toBeCloseTo(0.955)
    expect(combine([])).toBe(0)
  })

  it('maps scores to graded actions', () => {
    expect(levelFor(0.1, config)).toBe('allow')
    expect(levelFor(0.4, config)).toBe('throttle')
    expect(levelFor(0.7, config)).toBe('challenge')
    expect(levelFor(0.9, config)).toBe('block')
  })

  it('scales the throttle delay within its band', () => {
    expect(decide(0.35, [], config, { hasPass: false }).delayMs).toBe(250)
    expect(decide(0.59, [], config, { hasPass: false }).delayMs).toBeGreaterThan(1_300)
  })

  it('lets a solved challenge downgrade to throttle, but never a block', () => {
    expect(decide(0.7, [], config, { hasPass: true }).level).toBe('throttle')
    expect(decide(0.9, [], config, { hasPass: true }).level).toBe('block')
  })

  it('remembers risk with a half-life', () => {
    const previous = { score: 0.9, atMs: NOW - 5 * 60_000 }
    expect(withMemory(0, previous, NOW, config.memoryHalfLifeMs)).toBeCloseTo(0.45)
    expect(withMemory(0.7, previous, NOW, config.memoryHalfLifeMs)).toBe(0.7)
    expect(withMemory(0.2, null, NOW, config.memoryHalfLifeMs)).toBe(0.2)
  })
})
