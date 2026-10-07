/** Rate, interaction and device-sharing signals. */
import { ramp } from '../stats'
import { clean, type Signal } from '../types'

/** Sliding-window bid rates per user, IP and device (Redis counters). */
export const bidRate: Signal = {
  name: 'bid_rate',
  evaluate({ rate }, config) {
    const limits = config.rate
    const checks: [number, number, string][] = [
      [rate.userPerSecond, limits.userPerSecond, 'bids/s from this account'],
      [rate.userPerMinute, limits.userPerMinute, 'bids/min from this account'],
      [rate.ipPerMinute, limits.ipPerMinute, 'bids/min from this IP'],
      [rate.devicePerMinute, limits.devicePerMinute, 'bids/min from this device'],
    ]
    let worst = clean
    for (const [value, limit, label] of checks) {
      // At the limit → 0; at 3× the limit → 1.
      const score = ramp(value, limit, limit * 3)
      if (score > worst.score) worst = { score, reason: `${value} ${label} (limit ${limit})` }
    }
    return worst
  },
}

/**
 * Bids without any real (isTrusted) pointer or keyboard event since the
 * previous one. Client-reported, so it only catches naive scripts.
 */
export const noInteraction: Signal = {
  name: 'no_interaction',
  evaluate({ interaction }) {
    if (interaction.trustedEvents > 0) return clean
    return { score: 0.45, reason: 'no real click or key press before the bid' }
  },
}

/** A hidden field only bots fill in. Conclusive on its own. */
export const honeypot: Signal = {
  name: 'honeypot',
  evaluate({ interaction }) {
    if (interaction.honeypot === '') return clean
    return { score: 1, reason: 'filled in a hidden honeypot field' }
  },
}

/** Many accounts bidding from one device fingerprint: a click farm. */
export const sharedDevice: Signal = {
  name: 'shared_device',
  evaluate({ accountsOnDevice }, { devices }) {
    if (accountsOnDevice < devices.suspiciousAccounts) return clean
    const score =
      0.4 + 0.5 * ramp(accountsOnDevice, devices.suspiciousAccounts, devices.farmAccounts)
    return { score, reason: `${accountsOnDevice} accounts bid from the same device fingerprint` }
  },
}
