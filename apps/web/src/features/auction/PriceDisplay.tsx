import type { Auction } from '@bidrush/shared'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import { cn } from '@/lib/cn'
import { formatCredits } from '@/lib/format'

/**
 * Current price with a flip animation on every change. A polite live
 * region announces new high bids to screen readers.
 */
export function PriceDisplay({ auction, mine }: { auction: Auction; mine: boolean }) {
  const reduceMotion = useReducedMotion()
  const announcement = auction.leader
    ? `New high bid: ${formatCredits(auction.currentPrice)} by ${mine ? 'you' : auction.leader.displayName}`
    : `Starting price ${formatCredits(auction.currentPrice)}`

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs font-semibold uppercase tracking-widest text-ink-muted">
        {auction.status === 'ended'
          ? auction.leader
            ? 'Winning bid'
            : 'No winner'
          : auction.leader
            ? 'Current bid'
            : 'Starting price'}
      </span>
      <div className="relative h-14 overflow-hidden" aria-hidden>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={auction.currentPrice}
            className={cn(
              'block font-mono text-5xl font-bold tabular-nums',
              mine && 'text-winning',
            )}
            initial={reduceMotion ? false : { y: -40, opacity: 0, scale: 1.1 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { y: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
          >
            {auction.currentPrice.toLocaleString('en-US')}
          </motion.span>
        </AnimatePresence>
      </div>
      <span className="text-sm text-ink-muted">
        {auction.leader ? (
          <>
            by <strong className="text-ink">{mine ? 'you' : auction.leader.displayName}</strong>
          </>
        ) : (
          'No bids yet'
        )}
      </span>
      <p className="sr-only" aria-live="polite" aria-atomic>
        {announcement}
      </p>
    </div>
  )
}
