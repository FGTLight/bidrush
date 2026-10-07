/**
 * What the user actually did before each bid, sent with it to the anti-bot
 * engine: the number of real (isTrusted) pointer/keyboard events since the
 * previous bid, and the reaction time since the price last changed on screen.
 * Synthetic events dispatched by scripts have isTrusted === false.
 */
import type { InteractionSignals } from '@bidrush/shared'

let trustedEvents = 0
let priceShownAt: number | null = null
let installed = false

function count(event: Event) {
  if (event.isTrusted) trustedEvents += 1
}

export function installInteractionTracking(target: Window = window) {
  if (installed) return
  installed = true
  for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
    target.addEventListener(type, count, { capture: true, passive: true })
  }
}

/** Call when a new price is rendered: reaction times are measured from here. */
export function markPriceShown(at = performance.now()) {
  priceShownAt = at
}

/** The signals for one bid; resets the event counter. */
export function takeInteraction(honeypot: string, at = performance.now()): InteractionSignals {
  const signals = {
    trustedEvents,
    honeypot,
    reactionMs: priceShownAt === null ? null : Math.max(0, Math.round(at - priceShownAt)),
  }
  trustedEvents = 0
  return signals
}

/** Test helper. */
export function resetInteraction() {
  trustedEvents = 0
  priceShownAt = null
}
