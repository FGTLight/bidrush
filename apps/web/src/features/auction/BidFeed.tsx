import type { Bid } from '@bidrush/shared'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import { cn } from '@/lib/cn'
import { formatCredits, formatTime } from '@/lib/format'

import type { PendingBid } from './room-state'

export function BidFeed({
  bids,
  pending,
  userId,
}: {
  bids: Bid[]
  pending: PendingBid[]
  userId: string | null
}) {
  const reduceMotion = useReducedMotion()
  if (bids.length === 0 && pending.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-muted">No bids yet. Be the first.</p>
  }
  return (
    <ol className="flex flex-col gap-1.5" aria-label="Bid history, newest first">
      {pending.map((p) => (
        <li
          key={p.bidId}
          className="flex items-center justify-between rounded-xl border border-dashed border-brand-400 px-3 py-2 text-sm opacity-70"
        >
          <span className="font-medium">You</span>
          <span className="flex items-center gap-2 font-mono tabular-nums">
            {formatCredits(p.amount)}
            <span className="text-xs text-ink-muted">
              {p.verifying ? 'verifying you’re human…' : 'sending…'}
            </span>
          </span>
        </li>
      ))}
      <AnimatePresence initial={false}>
        {bids.map((bid, i) => {
          const mine = bid.bidder.id === userId
          return (
            <motion.li
              key={bid.id}
              layout={!reduceMotion}
              initial={
                reduceMotion
                  ? false
                  : { opacity: 0, x: -16, backgroundColor: 'rgba(124,58,237,0.18)' }
              }
              animate={{ opacity: 1, x: 0, backgroundColor: 'rgba(124,58,237,0)' }}
              transition={{ duration: 0.4 }}
              className={cn(
                'flex items-center justify-between rounded-xl px-3 py-2 text-sm',
                i === 0 && 'ring-1 ring-brand-500/40',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="w-8 font-mono text-xs text-ink-muted">#{bid.seq}</span>
                <span className={cn('font-medium', mine && 'text-brand-600')}>
                  {mine ? 'You' : bid.bidder.displayName}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="font-mono font-semibold tabular-nums">
                  {formatCredits(bid.amount)}
                </span>
                <time className="hidden text-xs text-ink-muted sm:inline" dateTime={bid.createdAt}>
                  {formatTime(bid.createdAt)}
                </time>
              </span>
            </motion.li>
          )
        })}
      </AnimatePresence>
    </ol>
  )
}
