import { z } from 'zod'

import {
  auctionSchema,
  auctionStatusSchema,
  bidSchema,
  credits,
  isoDate,
  ledgerEntrySchema,
  meSchema,
  riskLevelSchema,
  walletSchema,
} from './domain'

// ---------------------------------------------------------------- auth

/** Trimmed and lower-cased before it is validated. */
const email = z.string().trim().toLowerCase().pipe(z.email().max(254))

export const signUpBody = z.object({
  email,
  password: z.string().min(8).max(128),
  displayName: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[\p{L}\p{N} _.-]+$/u, 'Letters, numbers, spaces, dots, dashes and underscores'),
})
export type SignUpBody = z.infer<typeof signUpBody>

export const signInBody = z.object({
  email,
  password: z.string().min(1).max(128),
})
export type SignInBody = z.infer<typeof signInBody>

export const sessionResponse = z.object({
  user: meSchema,
  wallet: walletSchema,
  /** Echo this in the `x-csrf-token` header of every mutating request. */
  csrfToken: z.string(),
})
export type SessionResponse = z.infer<typeof sessionResponse>

// ---------------------------------------------------------------- auctions

export const auctionListQuery = z.object({
  status: z.union([auctionStatusSchema, z.literal('active')]).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(24),
})
export type AuctionListQuery = z.infer<typeof auctionListQuery>

export const auctionListResponse = z.object({
  auctions: z.array(auctionSchema),
  serverTime: z.number(),
})

export const auctionDetailResponse = z.object({
  auction: auctionSchema,
  recentBids: z.array(bidSchema),
  serverTime: z.number(),
})

// ---------------------------------------------------------------- me

export const myBidsResponse = z.object({
  items: z.array(
    z.object({
      auction: auctionSchema,
      myHighestBid: credits,
      /** Leading a live auction, or the winner of an ended one. */
      winning: z.boolean(),
    }),
  ),
})

export const walletResponse = z.object({
  wallet: walletSchema,
  ledger: z.array(ledgerEntrySchema),
})

// ---------------------------------------------------------------- admin

export const createAuctionBody = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(2000).default(''),
    imageUrl: z.url().nullable().default(null),
    startingPrice: credits,
    minIncrement: credits.min(1),
    startsAt: isoDate,
    /** Defaults to the server's configured duration (60 s). */
    durationMs: z.number().int().min(10_000).max(3_600_000).optional(),
  })
  .refine((v) => Date.parse(v.startsAt) > Date.now() - 5_000, {
    message: 'Must be in the future',
    path: ['startsAt'],
  })
export type CreateAuctionBody = z.infer<typeof createAuctionBody>

export const flaggedUserSchema = z.object({
  user: meSchema.pick({ id: true, displayName: true, email: true }),
  riskScore: z.number().min(0).max(1),
  level: riskLevelSchema,
  blocked: z.boolean(),
  lastEventAt: isoDate,
  topReasons: z.array(z.string()),
})
export type FlaggedUser = z.infer<typeof flaggedUserSchema>

export const riskEventSchema = z.object({
  id: z.string(),
  score: z.number().min(0).max(1),
  level: riskLevelSchema,
  signals: z.array(z.object({ name: z.string(), score: z.number(), reason: z.string() })),
  auctionId: z.uuid().nullable(),
  createdAt: isoDate,
})
export type RiskEvent = z.infer<typeof riskEventSchema>

export const metricsSnapshot = z.object({
  bidsPerSecond: z.number(),
  bidLatencyMs: z.object({ p50: z.number(), p95: z.number(), p99: z.number() }),
  connectedSockets: z.number().int(),
  liveAuctions: z.number().int(),
  instanceId: z.string(),
})
export type MetricsSnapshot = z.infer<typeof metricsSnapshot>
