import { z } from 'zod'

import { MAX_CREDITS } from './constants'

export const credits = z.number().int().min(0).max(MAX_CREDITS)
/** ISO 8601 timestamp, always UTC. */
export const isoDate = z.iso.datetime({ offset: true })

export const auctionStatuses = ['scheduled', 'live', 'ended', 'cancelled'] as const
export const auctionStatusSchema = z.enum(auctionStatuses)
export type AuctionStatus = z.infer<typeof auctionStatusSchema>

export const roleSchema = z.enum(['user', 'admin'])
export type Role = z.infer<typeof roleSchema>

export const publicUserSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
})
export type PublicUser = z.infer<typeof publicUserSchema>

export const meSchema = publicUserSchema.extend({
  email: z.email(),
  role: roleSchema,
})
export type Me = z.infer<typeof meSchema>

export const auctionSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  imageUrl: z.url().nullable(),
  status: auctionStatusSchema,
  startingPrice: credits,
  minIncrement: credits.min(1),
  currentPrice: credits,
  /** Null until the first bid. */
  leader: publicUserSchema.nullable(),
  bidCount: z.number().int().min(0),
  bidderCount: z.number().int().min(0),
  startsAt: isoDate,
  /** Moves forward on soft-close extensions. */
  endsAt: isoDate,
  /** Total soft-close extension applied so far. */
  extendedMs: z.number().int().min(0),
})
export type Auction = z.infer<typeof auctionSchema>

export const bidSchema = z.object({
  id: z.uuid(),
  auctionId: z.uuid(),
  bidder: publicUserSchema,
  amount: credits,
  createdAt: isoDate,
})
export type Bid = z.infer<typeof bidSchema>

export const walletSchema = z.object({
  /** Credits the user can still bid with. */
  available: credits,
  /** Credits held because the user is leading one or more auctions. */
  reserved: credits,
})
export type Wallet = z.infer<typeof walletSchema>

export const ledgerEntryKinds = ['grant', 'reserve', 'release', 'settle'] as const
/** One ledger transaction, as it affected the user's two accounts. */
export const ledgerEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(ledgerEntryKinds),
  /** Change to the available balance (negative when credits leave it). */
  available: z.number().int(),
  /** Change to the reserved balance. */
  reserved: z.number().int(),
  auctionId: z.uuid().nullable(),
  auctionTitle: z.string().nullable(),
  createdAt: isoDate,
})
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>

export const riskLevels = ['allow', 'throttle', 'challenge', 'block'] as const
export const riskLevelSchema = z.enum(riskLevels)
export type RiskLevel = z.infer<typeof riskLevelSchema>
