import { describe, expect, it } from 'vitest'

import { createAuctionBody, signUpBody } from './api'
import { clientMessageSchema, serverMessageSchema } from './ws'
import { estimateOffset, remainingMs, sampleOffset } from './time'

const uuid = '0b6f1f1e-6a55-4c3e-9a8e-6a1f6d2b9c01'
const interaction = { trustedEvents: 3, honeypot: '', reactionMs: 420 }

describe('client messages', () => {
  it('accepts a valid bid', () => {
    const msg = { type: 'bid', bidId: uuid, auctionId: uuid, amount: 120, interaction }
    expect(clientMessageSchema.parse(msg)).toEqual(msg)
  })

  it.each([
    ['fractional amount', { amount: 10.5 }],
    ['zero amount', { amount: 0 }],
    ['non-uuid bid id', { bidId: 'abc' }],
    ['negative trusted events', { interaction: { ...interaction, trustedEvents: -1 } }],
  ])('rejects a bid with a %s', (_, patch) => {
    const msg = { type: 'bid', bidId: uuid, auctionId: uuid, amount: 120, interaction, ...patch }
    expect(clientMessageSchema.safeParse(msg).success).toBe(false)
  })

  it('rejects unknown message types', () => {
    expect(clientMessageSchema.safeParse({ type: 'drop_table' }).success).toBe(false)
  })

  it('accepts a hello with partial browser signals', () => {
    const msg = { type: 'hello', signals: { webdriver: false, timezone: 'Europe/Madrid' } }
    expect(clientMessageSchema.safeParse(msg).success).toBe(true)
  })
})

describe('server messages', () => {
  it('discriminates bid acks by status', () => {
    const rejected = {
      type: 'bid_ack',
      status: 'rejected',
      bidId: uuid,
      code: 'OUTBID',
      message: 'Someone placed a higher bid first.',
    }
    expect(serverMessageSchema.safeParse(rejected).success).toBe(true)
    expect(serverMessageSchema.safeParse({ ...rejected, code: 'NOPE' }).success).toBe(false)
  })
})

describe('REST payloads', () => {
  it('normalizes sign-up emails', () => {
    const body = signUpBody.parse({
      email: '  Ada@Example.COM ',
      password: 'correct horse',
      displayName: 'Ada',
    })
    expect(body.email).toBe('ada@example.com')
  })

  it('rejects auctions scheduled in the past', () => {
    const result = createAuctionBody.safeParse({
      title: 'Vintage camera',
      startingPrice: 100,
      minIncrement: 5,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
    })
    expect(result.success).toBe(false)
  })
})

describe('clock sync', () => {
  it('computes the offset of one round trip', () => {
    // Sent at 1000, answered with server time 5100, received at 1200:
    // the midpoint 1100 corresponds to 5100.
    expect(sampleOffset({ sentAt: 1000, serverTime: 5100, receivedAt: 1200 })).toBe(4000)
  })

  it('ignores samples distorted by a slow round trip', () => {
    const samples = [
      { sentAt: 0, serverTime: 4010, receivedAt: 20 }, // rtt 20 → 4000
      { sentAt: 100, serverTime: 4110, receivedAt: 120 }, // rtt 20 → 4000
      { sentAt: 200, serverTime: 4900, receivedAt: 1200 }, // rtt 1000 → 4200 (outlier)
      { sentAt: 300, serverTime: 4312, receivedAt: 324 }, // rtt 24 → 4000
    ]
    expect(estimateOffset(samples)).toBe(4000)
  })

  it('never reports negative time left', () => {
    const endsAt = new Date(10_000).toISOString()
    expect(remainingMs(endsAt, 0, 4_000)).toBe(6_000)
    expect(remainingMs(endsAt, 2_000, 4_000)).toBe(4_000)
    expect(remainingMs(endsAt, 0, 20_000)).toBe(0)
  })
})
