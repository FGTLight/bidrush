/**
 * Proof-of-work for the anti-bot challenge: find a nonce so that
 * sha256(prefix + nonce) starts with `difficulty` zero hex digits.
 * Difficulty 4 takes ~65k hashes: about a second for a browser, and a real
 * cost for a bot hammering the server.
 */
const encoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')

export async function solveChallenge(
  prefix: string,
  difficulty: number,
  { signal, batch = 256 }: { signal?: AbortSignal; batch?: number } = {},
): Promise<string> {
  const target = '0'.repeat(difficulty)
  for (let start = 0; ; start += batch) {
    if (signal?.aborted) throw new Error('aborted')
    // Hash a batch in parallel, then yield so the page stays responsive.
    const nonces = Array.from({ length: batch }, (_, i) => (start + i).toString(36))
    const hashes = await Promise.all(
      nonces.map((n) => crypto.subtle.digest('SHA-256', encoder.encode(prefix + n))),
    )
    const found = hashes.findIndex((h) => toHex(h).startsWith(target))
    if (found >= 0) return nonces[found] ?? ''
  }
}
