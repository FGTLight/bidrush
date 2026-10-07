import { z } from 'zod'

/**
 * Browser facts collected once per connection and sent in the `hello`
 * message. Used only for fraud prevention (see the README's privacy
 * section). Every field is optional: a missing value is itself a weak
 * signal, never an error.
 */
export const browserSignalsSchema = z.object({
  userAgent: z.string().max(512).optional(),
  /** `navigator.webdriver`: true under Selenium, Puppeteer, Playwright. */
  webdriver: z.boolean().optional(),
  languages: z.array(z.string().max(35)).max(20).optional(),
  /** IANA zone from Intl, e.g. "America/Havana". */
  timezone: z.string().max(64).optional(),
  /** Minutes, as returned by `Date#getTimezoneOffset()`. */
  timezoneOffset: z.number().int().min(-900).max(900).optional(),
  screen: z
    .object({
      width: z.number().int().min(0).max(20_000),
      height: z.number().int().min(0).max(20_000),
      colorDepth: z.number().int().min(0).max(64),
      pixelRatio: z.number().min(0).max(16),
    })
    .optional(),
  hardwareConcurrency: z.number().int().min(0).max(1024).optional(),
  /** GB, rounded by the browser (Chrome only). */
  deviceMemory: z.number().min(0).max(1024).optional(),
  touchPoints: z.number().int().min(0).max(64).optional(),
  pluginsCount: z.number().int().min(0).max(1000).optional(),
  /** Hints such as "HeadlessChrome" in the UA or a missing `window.chrome`. */
  headlessHints: z.array(z.string().max(64)).max(20).optional(),
  /** Short hash of a canvas drawing; part of the device fingerprint. */
  canvasHash: z.string().max(128).optional(),
})
export type BrowserSignals = z.infer<typeof browserSignalsSchema>

/** Sent with every bid: what the user actually did since the last one. */
export const interactionSignalsSchema = z.object({
  /** `isTrusted` pointer/keyboard events since the previous bid. */
  trustedEvents: z.number().int().min(0).max(100_000),
  /** Value of a hidden field humans never see. Anything but "" is a bot. */
  honeypot: z.string().max(256),
  /** Milliseconds between the price change shown and the bid click. */
  reactionMs: z.number().int().min(0).max(3_600_000).nullable(),
})
export type InteractionSignals = z.infer<typeof interactionSignalsSchema>
