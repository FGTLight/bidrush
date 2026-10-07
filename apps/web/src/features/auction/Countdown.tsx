import type { Auction } from '@bidrush/shared'

import { cn } from '@/lib/cn'
import { formatCountdown } from '@/lib/format'
import { useClock } from '@/realtime/RealtimeProvider'

const SIZE = 220
const STROKE = 12
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
export const URGENT_MS = 10_000

/** Time left from the server's point of view; the server alone ends auctions. */
export function useTimeLeft(auction: Pick<Auction, 'status' | 'startsAt' | 'endsAt'>) {
  const { server } = useClock(100)
  const target = auction.status === 'scheduled' ? auction.startsAt : auction.endsAt
  return Math.max(0, Date.parse(target) - server)
}

/**
 * Big server-synced countdown with a progress ring. The ring drains over the
 * auction's full span (including soft-close extensions), and turns urgent in
 * the last ten seconds. At zero it waits for the server's `auction_ended`.
 */
export function Countdown({ auction }: { auction: Auction }) {
  const msLeft = useTimeLeft(auction)
  const span = Date.parse(auction.endsAt) - Date.parse(auction.startsAt)
  const live = auction.status === 'live'
  const fraction =
    live && span > 0 ? Math.min(1, msLeft / span) : auction.status === 'ended' ? 0 : 1
  const urgent = live && msLeft <= URGENT_MS
  const settling = live && msLeft === 0

  const label =
    auction.status === 'scheduled'
      ? 'Starts in'
      : auction.status === 'ended'
        ? 'Ended'
        : settling
          ? 'Closing…'
          : 'Time left'

  return (
    <div className="relative mx-auto grid size-[220px] place-items-center">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="absolute inset-0 -rotate-90"
        aria-hidden
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          className="fill-none stroke-surface-muted"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
          className={cn(
            'fill-none transition-[stroke-dashoffset] duration-100 ease-linear',
            urgent ? 'stroke-urgent' : 'stroke-brand-600',
          )}
        />
      </svg>
      <div className="flex flex-col items-center">
        <span className="text-xs font-semibold uppercase tracking-widest text-ink-muted">
          {label}
        </span>
        <span
          className={cn(
            'font-mono text-5xl font-bold tabular-nums',
            urgent && 'text-urgent',
            urgent && msLeft > 0 && 'animate-pulse',
          )}
          // Read out on demand, not every 100 ms.
          aria-live="off"
          role="timer"
          aria-label={
            auction.status === 'ended' ? 'Auction ended' : `${formatCountdown(msLeft)} left`
          }
        >
          {auction.status === 'ended' ? '0.0' : formatCountdown(msLeft)}
        </span>
      </div>
    </div>
  )
}
