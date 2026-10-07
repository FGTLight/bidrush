import { describe, expect, it } from 'vitest'

import { TokenBucket } from './token-bucket'

describe('TokenBucket', () => {
  it('allows a burst, then refills at the configured rate', () => {
    let now = 0
    const bucket = new TokenBucket(10, 3, () => now)

    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([0, 0, 0])
    // Empty: the next token arrives in 1/10 s.
    expect(bucket.take()).toBe(100)

    now += 100
    expect(bucket.take()).toBe(0)
    expect(bucket.take()).toBeGreaterThan(0)
  })

  it('never stores more than the burst', () => {
    let now = 0
    const bucket = new TokenBucket(10, 2, () => now)
    now += 60_000
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([0, 0, 100])
  })
})
