import { Hourglass, Users } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Link, useParams } from 'react-router'

import { Badge, EmptyState, Skeleton } from '@/components/ui'
import { buttonClass, cardClass } from '@/components/ui/styles'
import { useSession } from '@/features/auth/session'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useClock } from '@/realtime/RealtimeProvider'

import { BidFeed } from './BidFeed'
import { BidPanel } from './BidPanel'
import { Countdown } from './Countdown'
import { PriceDisplay } from './PriceDisplay'
import { myStatus } from './room-state'
import { useAuctionRoom } from './useAuctionRoom'

const BANNER_MS = 3_000

function ExtensionBanner({
  extendedAt,
  extendedMs,
}: {
  extendedAt: number | null
  extendedMs: number
}) {
  const { local } = useClock(250)
  const visible = extendedAt !== null && local - extendedAt < BANNER_MS
  return (
    <AnimatePresence>
      {visible && (
        <motion.p
          role="status"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="flex items-center justify-center gap-2 rounded-xl bg-urgent/15 px-3 py-2 text-sm font-semibold text-urgent"
        >
          <Hourglass className="size-4" aria-hidden />
          Late bid! Time extended (+{Math.round(extendedMs / 1000)} s total)
        </motion.p>
      )}
    </AnimatePresence>
  )
}

export default function AuctionRoomPage() {
  const { id = '' } = useParams()
  const { data: session } = useSession()
  const { state, placeBid, dismissRejection } = useAuctionRoom(id)
  const { auction } = state
  useDocumentTitle(auction?.title)

  if (state.notFound) {
    return (
      <EmptyState
        title="Auction not found"
        description="It may have been removed, or the link is wrong."
        action={
          <Link to="/auctions" className={buttonClass()}>
            See live auctions
          </Link>
        }
      />
    )
  }

  if (!auction) {
    return (
      <div
        className="grid gap-6 lg:grid-cols-[1fr_380px]"
        role="status"
        aria-label="Loading auction"
      >
        <Skeleton className="h-96" />
        <Skeleton className="h-[480px]" />
      </div>
    )
  }

  const userId = session?.user.id ?? null
  const status = myStatus(state, userId)
  const statusTone =
    auction.status === 'live' ? 'live' : auction.status === 'scheduled' ? 'scheduled' : 'ended'

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <section className="flex flex-col gap-6" aria-label="Auction">
        <div className="flex flex-col gap-3">
          <Link to="/auctions" className="text-sm text-ink-muted hover:text-ink">
            ← All auctions
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight">{auction.title}</h1>
            <Badge tone={statusTone}>{auction.status}</Badge>
          </div>
          {auction.description && (
            <p className="max-w-prose text-ink-muted">{auction.description}</p>
          )}
          <p className="flex items-center gap-4 text-sm text-ink-muted">
            <span className="flex items-center gap-1.5">
              <Users className="size-4" aria-hidden />
              {auction.bidderCount} {auction.bidderCount === 1 ? 'bidder' : 'bidders'}
            </span>
            <span>{auction.bidCount} bids</span>
          </p>
        </div>

        {auction.imageUrl && (
          <img
            src={auction.imageUrl}
            alt=""
            className="aspect-video w-full rounded-2xl border border-line object-cover"
          />
        )}

        <div className={`${cardClass} p-4`}>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-ink-muted">
            Live bids
          </h2>
          <BidFeed bids={state.bids} pending={state.pending} userId={userId} />
        </div>
      </section>

      <aside
        // First on phones: in a 60-second auction the bid buttons must not be below the fold.
        className={`${cardClass} order-first flex h-fit flex-col gap-6 p-6 lg:sticky lg:top-24 lg:order-none`}
        aria-label="Bidding"
      >
        <Countdown auction={auction} />
        <ExtensionBanner extendedAt={state.extendedAt} extendedMs={auction.extendedMs} />
        <PriceDisplay auction={auction} mine={auction.leader?.id === userId} />
        <BidPanel
          auction={auction}
          room={state}
          status={status}
          available={session?.wallet.available ?? null}
          onBid={placeBid}
          onDismiss={dismissRejection}
        />
      </aside>
    </div>
  )
}
