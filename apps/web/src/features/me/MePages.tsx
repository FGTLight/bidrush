import { myBidsResponse, walletResponse } from '@bidrush/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, Navigate, useLocation } from 'react-router'

import { Badge, EmptyState, Skeleton } from '@/components/ui'
import { buttonClass, cardClass } from '@/components/ui/styles'
import { useSession } from '@/features/auth/session'
import { request } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCredits, formatDateTime } from '@/lib/format'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

/** Guests are sent to sign in, then brought back. */
function useRequireSession() {
  const { data: session, isPending } = useSession()
  const location = useLocation()
  if (isPending) return { ready: false as const }
  if (!session) {
    return {
      ready: false as const,
      redirect: <Navigate to="/sign-in" replace state={{ from: location.pathname }} />,
    }
  }
  return { ready: true as const, session }
}

export function MyBidsPage() {
  useDocumentTitle('My bids')
  const auth = useRequireSession()
  const query = useQuery({
    queryKey: ['me', 'bids'],
    queryFn: ({ signal }) => request('/me/bids', { schema: myBidsResponse, signal }),
    enabled: auth.ready,
  })
  if (!auth.ready) return auth.redirect ?? <Skeleton className="h-64" />

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-extrabold tracking-tight">My bids & wins</h1>
      {query.isPending ? (
        <Skeleton className="h-64" />
      ) : !query.data || query.data.items.length === 0 ? (
        <EmptyState
          title="No bids yet"
          description="Jump into a live auction: they only last a minute."
          action={
            <Link to="/auctions" className={buttonClass()}>
              See live auctions
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {query.data.items.map(({ auction, myHighestBid, winning }) => {
            const ended = auction.status === 'ended'
            return (
              <li key={auction.id}>
                <Link
                  to={`/auctions/${auction.id}`}
                  className={cn(
                    cardClass,
                    'flex flex-wrap items-center gap-x-4 gap-y-1 p-4 transition hover:border-brand-500',
                  )}
                >
                  <span className="flex-1 font-semibold">{auction.title}</span>
                  <Badge tone={winning ? 'winning' : ended ? 'ended' : 'live'}>
                    {winning ? (ended ? 'Won' : 'Winning') : ended ? 'Lost' : 'Outbid'}
                  </Badge>
                  <span className="text-sm text-ink-muted">
                    my best {formatCredits(myHighestBid)} · price{' '}
                    {formatCredits(auction.currentPrice)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

const kindLabel = {
  grant: 'Credits granted',
  reserve: 'Held for a bid',
  release: 'Released (outbid)',
  settle: 'Paid for a win',
}

export function WalletPage() {
  useDocumentTitle('Wallet')
  const auth = useRequireSession()
  const query = useQuery({
    queryKey: ['me', 'wallet'],
    queryFn: ({ signal }) => request('/me/wallet', { schema: walletResponse, signal }),
    enabled: auth.ready,
  })
  if (!auth.ready) return auth.redirect ?? <Skeleton className="h-64" />
  const wallet = query.data?.wallet ?? auth.session.wallet

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-extrabold tracking-tight">Wallet</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={`${cardClass} p-5`}>
          <p className="text-sm text-ink-muted">Available</p>
          <p className="font-mono text-3xl font-bold tabular-nums">
            {formatCredits(wallet.available)}
          </p>
        </div>
        <div className={`${cardClass} p-5`}>
          <p className="text-sm text-ink-muted">Reserved in auctions you lead</p>
          <p className="font-mono text-3xl font-bold tabular-nums">
            {formatCredits(wallet.reserved)}
          </p>
        </div>
      </div>
      <section className={`${cardClass} p-5`}>
        <h2 className="mb-1 font-semibold">Ledger</h2>
        <p className="mb-4 text-sm text-ink-muted">
          Every movement of your credits, from an append-only, double-entry ledger.
        </p>
        {query.isPending ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-ink-muted">
                <tr>
                  <th className="py-2 font-medium">When</th>
                  <th className="py-2 font-medium">What</th>
                  <th className="py-2 text-right font-medium">Available</th>
                  <th className="py-2 text-right font-medium">Reserved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {query.data?.ledger.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 text-ink-muted">{formatDateTime(e.createdAt)}</td>
                    <td className="py-2">
                      {kindLabel[e.kind]}
                      {e.auctionTitle && e.auctionId && (
                        <>
                          {' · '}
                          <Link
                            to={`/auctions/${e.auctionId}`}
                            className="text-brand-600 hover:underline"
                          >
                            {e.auctionTitle}
                          </Link>
                        </>
                      )}
                    </td>
                    {[e.available, e.reserved].map((n, i) => (
                      <td
                        key={i}
                        className={cn(
                          'py-2 text-right font-mono tabular-nums',
                          n > 0 ? 'text-winning' : n < 0 ? 'text-outbid' : 'text-ink-muted',
                        )}
                      >
                        {n === 0 ? '—' : `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
