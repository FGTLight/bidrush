import { type Auction, auctionListResponse, type ServerMessage } from '@bidrush/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Crown, Users } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router'
import type { z } from 'zod'

import { Badge, EmptyState, Skeleton } from '@/components/ui'
import { buttonClass, cardClass } from '@/components/ui/styles'
import { useSession } from '@/features/auth/session'
import { URGENT_MS, useTimeLeft } from '@/features/auction/Countdown'
import { request } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCountdown, formatCredits } from '@/lib/format'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useRealtime, useServerMessages } from '@/realtime/RealtimeProvider'

type AuctionList = z.infer<typeof auctionListResponse>
export const auctionsKey = ['auctions', 'active'] as const

/** Applies a live event to the lobby list. */
export function applyToList(list: AuctionList, m: ServerMessage): AuctionList {
  const update = (id: string, fn: (a: Auction) => Auction) => ({
    ...list,
    auctions: list.auctions.map((a) => (a.id === id ? fn(a) : a)),
  })
  switch (m.type) {
    case 'bid_placed':
      return update(m.bid.auctionId, (a) =>
        m.bid.seq <= a.bidCount
          ? a
          : {
              ...a,
              currentPrice: m.currentPrice,
              leader: m.bid.bidder,
              bidCount: m.bidCount,
              bidderCount: m.bidderCount,
              endsAt: m.endsAt,
              extendedMs: m.extendedMs,
            },
      )
    case 'auction_started':
      return update(m.auction.id, () => m.auction)
    case 'auction_ended':
      return update(m.auctionId, (a) => ({
        ...a,
        status: 'ended',
        leader: m.winner,
        currentPrice: m.finalPrice,
      }))
    default:
      return list
  }
}

function useLiveAuctions() {
  const queryClient = useQueryClient()
  const realtime = useRealtime()
  const query = useQuery({
    queryKey: auctionsKey,
    queryFn: ({ signal }) =>
      request('/auctions?status=active', { schema: auctionListResponse, signal }),
    // New auctions appear by polling; changes to listed ones arrive live.
    refetchInterval: 15_000,
  })

  const ids = (query.data?.auctions ?? []).slice(0, 20).map((a) => a.id)
  const idsKey = ids.join(',')
  useEffect(() => {
    const unsubscribes = idsKey ? idsKey.split(',').map((id) => realtime.subscribe(id)) : []
    return () => {
      for (const u of unsubscribes) u()
    }
  }, [realtime, idsKey])

  useServerMessages((m) => {
    queryClient.setQueryData<AuctionList>(auctionsKey, (list) =>
      list ? applyToList(list, m) : list,
    )
  })
  return query
}

function AuctionCard({ auction, userId }: { auction: Auction; userId: string | null }) {
  const msLeft = useTimeLeft(auction)
  const live = auction.status === 'live'
  const urgent = live && msLeft <= URGENT_MS
  const leading = auction.leader?.id === userId

  return (
    <article
      className={cn(
        cardClass,
        'group relative flex flex-col gap-4 p-5 transition hover:-translate-y-0.5 hover:shadow-lg',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="line-clamp-2 font-bold leading-snug">
          <Link to={`/auctions/${auction.id}`} className="after:absolute after:inset-0">
            {auction.title}
          </Link>
        </h2>
        <Badge tone={live ? 'live' : auction.status === 'scheduled' ? 'scheduled' : 'ended'}>
          {auction.status}
        </Badge>
      </div>
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-muted">
            {auction.leader ? 'Current bid' : 'Starts at'}
          </p>
          <p className="font-mono text-2xl font-bold tabular-nums">
            {formatCredits(auction.currentPrice)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wider text-ink-muted">
            {live ? 'Ends in' : 'Starts in'}
          </p>
          <p className={cn('font-mono text-2xl font-bold tabular-nums', urgent && 'text-urgent')}>
            {formatCountdown(msLeft)}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between text-sm text-ink-muted">
        <span className="flex items-center gap-1.5">
          <Users className="size-4" aria-hidden />
          {auction.bidderCount} bidders
        </span>
        {leading && (
          <span className="flex items-center gap-1 font-semibold text-winning">
            <Crown className="size-4" aria-hidden /> You lead
          </span>
        )}
      </div>
    </article>
  )
}

export default function AuctionsPage() {
  useDocumentTitle('Live auctions')
  const { data, isPending, isError, refetch } = useLiveAuctions()
  const { data: session } = useSession()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">Live auctions</h1>
        <p className="text-ink-muted">60 seconds each. Late bids add time. Highest bid wins.</p>
      </div>
      {isError ? (
        <EmptyState
          title="Couldn't load auctions"
          action={
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() => void refetch()}
            >
              Try again
            </button>
          }
        />
      ) : isPending ? (
        <div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          role="status"
          aria-label="Loading auctions"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : data.auctions.length === 0 ? (
        <EmptyState
          title="No auctions right now"
          description="New ones are scheduled all the time. Check back in a minute."
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.auctions.map((a) => (
            <li key={a.id}>
              <AuctionCard auction={a} userId={session?.user.id ?? null} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
