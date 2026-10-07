/**
 * Defaults shared by the API (which enforces them) and the web app (which
 * only uses them for display). The API can override the auction timing
 * through its environment; the values it uses are sent to clients.
 */

/** Credits are whole numbers. Prices, bids and balances are all integers. */
export const MAX_CREDITS = 100_000_000

export const AUCTION_DEFAULTS = {
  /** Length of the live phase, before any soft-close extension. */
  durationMs: 60_000,
  /** A valid bid this close to the end extends the auction... */
  softCloseWindowMs: 5_000,
  /** ...by this much... */
  extensionMs: 5_000,
  /** ...but never by more than this in total. */
  maxExtensionMs: 30_000,
} as const

/** Quick-bid buttons in the auction room, as multiples of the min increment. */
export const QUICK_BID_STEPS = [1, 5, 10] as const

export const WS_LIMITS = {
  /** Larger WebSocket frames are rejected before parsing. */
  maxMessageBytes: 4 * 1024,
  /** Server-side heartbeat; clients that miss two are disconnected. */
  heartbeatMs: 15_000,
} as const

/** Path of the WebSocket endpoint, relative to the API origin. */
export const WS_PATH = '/ws'
