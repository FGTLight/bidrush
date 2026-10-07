import { createHash } from 'node:crypto'

import { solveChallenge } from './pow'

it('finds a nonce the server will accept', async () => {
  const nonce = await solveChallenge('abc123', 2)
  const hash = createHash('sha256').update(`abc123${nonce}`).digest('hex')
  expect(hash.startsWith('00')).toBe(true)
})

it('can be aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(solveChallenge('x', 6, { signal: controller.signal })).rejects.toThrow('aborted')
})
