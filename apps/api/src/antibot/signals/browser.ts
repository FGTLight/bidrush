/**
 * Browser signals from the connection's `hello`. Self-reported, so they
 * catch automation frameworks with default settings and careless scripts;
 * a determined bot can spoof them, which is why timing signals exist.
 */
import { clean, type Signal } from '../types'

/** Automation flags: navigator.webdriver, headless user agents, missing handshake. */
export const automation: Signal = {
  name: 'automation',
  evaluate({ browser }) {
    if (!browser)
      return { score: 0.5, reason: 'no browser signals: the client skipped the handshake' }
    if (browser.webdriver)
      return {
        score: 0.95,
        reason: 'navigator.webdriver is true (Selenium, Puppeteer, Playwright)',
      }
    if (browser.userAgent && /headless|phantomjs|puppeteer|playwright/i.test(browser.userAgent)) {
      return { score: 0.9, reason: `automation user agent: ${browser.userAgent.slice(0, 60)}` }
    }
    // One piece of evidence per fact: a zero-size window shows up both as a
    // client hint and in the screen size; counting it twice would inflate
    // the combined score with correlated signals.
    const hints = new Set(browser.headlessHints ?? [])
    if (browser.screen && (browser.screen.width === 0 || browser.screen.height === 0)) {
      hints.add('zero-outer-size')
    }
    if (hints.size > 0) {
      return {
        score: Math.min(0.7, 0.25 * hints.size),
        reason: `headless hints: ${[...hints].join(', ')}`,
      }
    }
    return clean
  },
}

/** UTC offset (minutes, like getTimezoneOffset) of an IANA zone right now. */
export function zoneOffsetMinutes(timeZone: string, at = new Date()): number | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value
    if (!part || part === 'GMT') return 0
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(part)
    if (!match) return null
    const minutes = Number(match[2]) * 60 + Number(match[3])
    // getTimezoneOffset is positive west of UTC: the opposite sign (and no -0).
    return match[1] === '+' && minutes !== 0 ? -minutes : minutes
  } catch {
    return null
  }
}

/** Facts that don't fit together, as with spoofed or emulated environments. */
export const inconsistency: Signal = {
  name: 'inconsistency',
  evaluate({ browser, nowMs }) {
    if (!browser) return clean
    const problems: string[] = []
    let score = 0

    if (browser.timezone && browser.timezoneOffset !== undefined) {
      const expected = zoneOffsetMinutes(browser.timezone, new Date(nowMs))
      if (expected === null) {
        problems.push(`unknown time zone "${browser.timezone}"`)
        score += 0.3
      } else if (expected !== browser.timezoneOffset) {
        problems.push(`time zone ${browser.timezone} doesn't match the clock offset`)
        score += 0.4
      }
    }
    if (browser.languages?.length === 0) {
      problems.push('no browser languages')
      score += 0.25
    }
    const mobileUa = browser.userAgent ? /Mobi|Android|iPhone/i.test(browser.userAgent) : false
    if (mobileUa && browser.touchPoints === 0) {
      problems.push('mobile user agent without touch support')
      score += 0.3
    }
    if (problems.length === 0) return clean
    return { score: Math.min(0.8, score), reason: problems.join('; ') }
  },
}
