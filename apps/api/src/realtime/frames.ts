import type { RawData } from 'ws'

/** A text frame's payload, whichever of the three shapes `ws` delivers it in. */
export function frameToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}
