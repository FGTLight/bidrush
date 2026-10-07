/**
 * Browser facts sent once per WebSocket connection (`hello`), used only to
 * detect automated bidding: never shared, never used for ads (see the
 * README's privacy section). Each probe is wrapped so a strict browser that
 * blocks one simply omits it.
 */
import type { BrowserSignals } from '@bidrush/shared'

function safe<T>(probe: () => T): T | undefined {
  try {
    return probe()
  } catch {
    return undefined
  }
}

/** Hints that the page runs in a headless or instrumented browser. */
export function headlessHints(win: Window & { chrome?: unknown } = window): string[] {
  const hints: string[] = []
  const ua = navigator.userAgent
  if (/Chrome/.test(ua) && !/Edg|OPR/.test(ua) && win.chrome === undefined)
    hints.push('no-window-chrome')
  // navigator.plugins is deprecated but still one of the clearest headless
  // tells: desktop Chrome always lists its built-in PDF viewer.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (/Chrome/.test(ua) && navigator.plugins.length === 0) hints.push('no-plugins')
  if (win.outerWidth === 0 && win.outerHeight === 0) hints.push('zero-outer-size')
  if (!navigator.languages.length) hints.push('no-languages')
  return hints
}

/**
 * Short hash of a canvas drawing. Fonts, GPU and anti-aliasing make it vary
 * between devices but stay stable on one: part of the device fingerprint.
 */
export async function canvasHash(): Promise<string | undefined> {
  const canvas = document.createElement('canvas')
  canvas.width = 240
  canvas.height = 60
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  ctx.textBaseline = 'top'
  ctx.font = '16px "Arial"'
  ctx.fillStyle = '#7c3aed'
  ctx.fillRect(10, 5, 120, 30)
  ctx.fillStyle = '#fde047'
  ctx.fillText('BidRush ⚡ 60s', 14, 12)
  ctx.globalCompositeOperation = 'multiply'
  ctx.fillStyle = 'rgba(0, 200, 120, 0.6)'
  ctx.beginPath()
  ctx.arc(170, 30, 22, 0, Math.PI * 2)
  ctx.fill()
  const data = new TextEncoder().encode(canvas.toDataURL())
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

let cachedCanvas: string | undefined
/** Computed once at startup (async), then reused by every reconnect. */
export async function warmUpSignals() {
  cachedCanvas = await safe(canvasHash)
}

export function collectSignals(): BrowserSignals {
  const nav = navigator as Navigator & { deviceMemory?: number }
  const signals: BrowserSignals = {
    userAgent: nav.userAgent.slice(0, 512),
    webdriver: nav.webdriver,
    languages: [...nav.languages].slice(0, 20),
    timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    timezoneOffset: new Date().getTimezoneOffset(),
    screen: {
      width: screen.width,
      height: screen.height,
      colorDepth: screen.colorDepth,
      pixelRatio: window.devicePixelRatio,
    },
    hardwareConcurrency: nav.hardwareConcurrency,
    touchPoints: nav.maxTouchPoints,
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see headlessHints
    pluginsCount: nav.plugins.length,
    headlessHints: safe(() => headlessHints()) ?? [],
  }
  if (nav.deviceMemory !== undefined) signals.deviceMemory = nav.deviceMemory
  if (cachedCanvas) signals.canvasHash = cachedCanvas
  return signals
}
