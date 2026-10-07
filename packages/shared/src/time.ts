/**
 * Clock sync, NTP style. The server is the only source of truth for time;
 * clients estimate `serverTime - localTime` and only use it for display.
 */

export interface ClockSample {
  /** Local time when the ping was sent. */
  sentAt: number
  /** Server time in the pong. */
  serverTime: number
  /** Local time when the pong arrived. */
  receivedAt: number
}

/** Offset assuming the request and the response took equally long. */
export function sampleOffset({ sentAt, serverTime, receivedAt }: ClockSample): number {
  return serverTime - (sentAt + receivedAt) / 2
}

/**
 * Best estimate from several samples: the ones with the shortest round trip
 * are the least distorted by network jitter, so take the median of those.
 */
export function estimateOffset(samples: readonly ClockSample[]): number {
  if (samples.length === 0) return 0
  const fastest = [...samples]
    .sort((a, b) => a.receivedAt - a.sentAt - (b.receivedAt - b.sentAt))
    .slice(0, Math.max(1, Math.ceil(samples.length / 2)))
  const offsets = fastest.map(sampleOffset).sort((a, b) => a - b)
  const mid = Math.floor(offsets.length / 2)
  const upper = offsets[mid] ?? 0
  return offsets.length % 2 === 1 ? upper : ((offsets[mid - 1] ?? upper) + upper) / 2
}

/** Milliseconds left, never negative, as seen from the client. */
export function remainingMs(endsAt: string, offsetMs: number, now = Date.now()): number {
  return Math.max(0, Date.parse(endsAt) - (now + offsetMs))
}
