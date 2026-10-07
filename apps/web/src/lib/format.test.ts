import { formatCountdown, formatCredits } from './format'

describe('formatCountdown', () => {
  it.each([
    [65_000, '1:05'],
    [60_000, '1:00'],
    [10_000, '0:10'],
    [9_450, '9.4'],
    [120, '0.1'],
    [0, '0.0'],
    [-5, '0.0'],
    [3_725_000, '1:02:05'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatCountdown(ms)).toBe(text)
  })
})

it('formats credits', () => {
  expect(formatCredits(12_345)).toBe('12,345 cr')
})
