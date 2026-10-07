import { z } from 'zod'

/** Why a bid was rejected. Clients switch on these, never on messages. */
export const bidErrorCodes = [
  'VALIDATION',
  'UNAUTHORIZED',
  'AUCTION_NOT_FOUND',
  'AUCTION_NOT_LIVE',
  'AUCTION_ENDED',
  'BID_TOO_LOW',
  'OUTBID',
  'SELF_OUTBID',
  'INSUFFICIENT_CREDITS',
  'RATE_LIMITED',
  'CHALLENGE_REQUIRED',
  'SUSPECTED_BOT',
  'BLOCKED',
  'INTERNAL',
] as const

export const bidErrorCodeSchema = z.enum(bidErrorCodes)
export type BidErrorCode = z.infer<typeof bidErrorCodeSchema>

/** Default English messages; the server may send a more specific one. */
export const bidErrorMessages: Record<BidErrorCode, string> = {
  VALIDATION: 'That bid is not valid.',
  UNAUTHORIZED: 'Sign in to bid.',
  AUCTION_NOT_FOUND: 'This auction does not exist.',
  AUCTION_NOT_LIVE: 'This auction has not started yet.',
  AUCTION_ENDED: 'This auction has ended.',
  BID_TOO_LOW: 'Your bid is below the minimum.',
  OUTBID: 'Someone placed a higher bid first.',
  SELF_OUTBID: "You're already the highest bidder.",
  INSUFFICIENT_CREDITS: "You don't have enough credits for this bid.",
  RATE_LIMITED: "You're bidding too fast. Slow down a little.",
  CHALLENGE_REQUIRED: 'Please confirm you are human to keep bidding.',
  SUSPECTED_BOT: 'This bid looks automated and was not accepted.',
  BLOCKED: 'Bidding is disabled for your account. Contact support.',
  INTERNAL: 'Something went wrong. Please try again.',
}

/** Error body of every non-2xx REST response. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Field errors for validation failures. */
    fields: z.record(z.string(), z.string()).optional(),
  }),
})
export type ApiError = z.infer<typeof apiErrorSchema>
