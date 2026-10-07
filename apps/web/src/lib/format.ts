const credits = new Intl.NumberFormat('en-US')

/** `1234` → `1,234 cr` */
export const formatCredits = (n: number) => `${credits.format(n)} cr`

/** Countdown text: `1:05`, and tenths in the last 10 seconds: `9.4`. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return '0.0'
  if (ms < 10_000) return (Math.floor(ms / 100) / 10).toFixed(1)
  const total = Math.ceil(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

const time = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})
export const formatTime = (iso: string) => time.format(new Date(iso))

const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso))
