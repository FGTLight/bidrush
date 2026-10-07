import { describe, expect, it } from 'vitest'

import { Metrics, percentile } from './metrics'

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(xs, 50)).toBe(50)
    expect(percentile(xs, 95)).toBe(95)
    expect(percentile(xs, 99)).toBe(99)
    expect(percentile([], 95)).toBe(0)
  })
})

describe('Metrics', () => {
  it('reports rate and latency percentiles', () => {
    const m = new Metrics('api-test')
    const now = 1_000_000
    for (let i = 1; i <= 100; i++) m.recordBid(i, i % 2 === 0, now - 5_000)
    m.recordBid(500, true, now - 20_000) // outside the 10 s rate window
    const s = m.snapshot(now)
    expect(s.bidsPerSecond).toBe(10)
    expect(s.bidLatencyMs).toEqual({ p50: 51, p95: 96, p99: 100 })
    expect(m.bidsAccepted).toBe(51)
  })

  it('exposes Prometheus text', () => {
    const m = new Metrics('api-1')
    m.recordBid(3, true)
    expect(m.prometheus()).toContain('bidrush_bids_total{instance="api-1",result="accepted"} 1')
  })
})
