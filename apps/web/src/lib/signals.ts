/**
 * Browser facts sent once per WebSocket connection (`hello`), used only to
 * detect automated bidding (see the README's privacy section).
 * Extended with headless hints and a canvas fingerprint in the anti-bot step.
 */
import type { BrowserSignals } from '@bidrush/shared'

export function collectSignals(): BrowserSignals {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    userAgent: nav.userAgent.slice(0, 512),
    webdriver: nav.webdriver,
    languages: [...nav.languages].slice(0, 20),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: new Date().getTimezoneOffset(),
    screen: {
      width: screen.width,
      height: screen.height,
      colorDepth: screen.colorDepth,
      pixelRatio: window.devicePixelRatio,
    },
    hardwareConcurrency: nav.hardwareConcurrency,
    ...(nav.deviceMemory !== undefined && { deviceMemory: nav.deviceMemory }),
    touchPoints: nav.maxTouchPoints,
  }
}
