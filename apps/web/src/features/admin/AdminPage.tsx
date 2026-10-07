import {
  adminMetricsResponse,
  auctionSchema,
  createAuctionBody,
  type FlaggedUser,
  flaggedUsersResponse,
  riskEventsResponse,
} from '@bidrush/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Gauge, Gavel, ShieldAlert, Users } from 'lucide-react'
import { type ReactNode, type SubmitEvent, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router'
import { z } from 'zod'

import { Badge, Button, EmptyState, Field, Skeleton } from '@/components/ui'
import { cardClass } from '@/components/ui/styles'
import { useSession } from '@/features/auth/session'
import { ApiRequestError, request } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime } from '@/lib/format'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

import { Sparkline } from './Sparkline'

const POLL_MS = 2_000
const HISTORY = 60

// ---------------------------------------------------------------- live metrics

function StatTile({
  icon,
  label,
  value,
  children,
}: {
  icon: ReactNode
  label: string
  value: string
  children?: ReactNode
}) {
  return (
    <div className={`${cardClass} flex flex-col gap-2 p-4`}>
      <p className="flex items-center gap-2 text-sm text-ink-muted">
        {icon}
        {label}
      </p>
      <p className="text-3xl font-bold">{value}</p>
      {children}
    </div>
  )
}

function LiveMetrics() {
  // Bids/s history for the sparkline, appended on every poll.
  const history = useRef<number[]>([])
  const { data, isError } = useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: async ({ signal }) => {
      const metrics = await request('/admin/metrics', { schema: adminMetricsResponse, signal })
      history.current = [...history.current, metrics.totals.bidsPerSecond].slice(-HISTORY)
      return { metrics, history: history.current }
    },
    refetchInterval: POLL_MS,
  })

  if (isError) return <p className="text-sm text-outbid">Metrics unavailable.</p>
  if (!data) return <Skeleton className="h-36" />
  const { totals, instances } = data.metrics

  return (
    <section aria-labelledby="metrics-heading" className="flex flex-col gap-4">
      <h2 id="metrics-heading" className="text-lg font-semibold">
        Live metrics{' '}
        <span className="text-sm font-normal text-ink-muted">· every 2 s, all instances</span>
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={<Activity className="size-4" aria-hidden />}
          label="Bids per second"
          value={String(totals.bidsPerSecond)}
        >
          <Sparkline
            values={data.history}
            sampleMs={POLL_MS}
            unit="bids/s"
            label="Bids per second"
          />
        </StatTile>
        <StatTile
          icon={<Gauge className="size-4" aria-hidden />}
          label="p95 bid latency"
          value={`${totals.p95LatencyMs} ms`}
        />
        <StatTile
          icon={<Users className="size-4" aria-hidden />}
          label="Connected sockets"
          value={String(totals.connectedSockets)}
        />
        <StatTile
          icon={<Gavel className="size-4" aria-hidden />}
          label="Live auctions"
          value={String(totals.liveAuctions)}
        />
      </div>
      <div className={`${cardClass} overflow-x-auto`}>
        <table className="w-full min-w-[520px] text-left text-sm tabular-nums">
          <caption className="sr-only">Per-instance metrics</caption>
          <thead className="text-xs uppercase tracking-wider text-ink-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Instance</th>
              <th className="px-4 py-2 text-right font-medium">Bids/s</th>
              <th className="px-4 py-2 text-right font-medium">p50</th>
              <th className="px-4 py-2 text-right font-medium">p95</th>
              <th className="px-4 py-2 text-right font-medium">p99</th>
              <th className="px-4 py-2 text-right font-medium">Sockets</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {instances.map((i) => (
              <tr key={i.instanceId}>
                <td className="px-4 py-2 font-mono">{i.instanceId}</td>
                <td className="px-4 py-2 text-right">{i.bidsPerSecond}</td>
                <td className="px-4 py-2 text-right">{i.bidLatencyMs.p50} ms</td>
                <td className="px-4 py-2 text-right">{i.bidLatencyMs.p95} ms</td>
                <td className="px-4 py-2 text-right">{i.bidLatencyMs.p99} ms</td>
                <td className="px-4 py-2 text-right">{i.connectedSockets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- create auction

/** `datetime-local` value for a Date, in the browser's time zone. */
function toLocalInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function CreateAuction() {
  const queryClient = useQueryClient()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [created, setCreated] = useState<string | null>(null)
  const [defaultStart] = useState(() => toLocalInput(new Date(Date.now() + 2 * 60_000)))
  const create = useMutation({
    mutationFn: (body: z.input<typeof createAuctionBody>) =>
      request('/admin/auctions', {
        method: 'POST',
        body,
        schema: z.object({ auction: auctionSchema }),
      }),
    onSuccess: ({ auction }) => {
      setCreated(auction.title)
      void queryClient.invalidateQueries({ queryKey: ['auctions'] })
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.fields) setErrors(error.fields)
    },
  })

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const text = (name: string) => {
      const value = form.get(name)
      return typeof value === 'string' ? value.trim() : ''
    }
    const startsAt = new Date(text('startsAt'))
    const body = {
      title: text('title'),
      description: text('description'),
      imageUrl: text('imageUrl') || null,
      startingPrice: Number(text('startingPrice')),
      minIncrement: Number(text('minIncrement')),
      startsAt: Number.isNaN(startsAt.getTime()) ? '' : startsAt.toISOString(),
      durationMs: Number(text('durationS')) * 1_000,
    }
    // The API's own schema, so the form and the server agree.
    const parsed = createAuctionBody.safeParse(body)
    setCreated(null)
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])))
      return
    }
    setErrors({})
    create.mutate(body, {
      onSuccess: () => {
        formElement.reset()
      },
    })
  }

  return (
    <section aria-labelledby="create-heading" className={`${cardClass} flex flex-col gap-4 p-5`}>
      <h2 id="create-heading" className="text-lg font-semibold">
        Schedule an auction
      </h2>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Title" name="title" required error={errors.title} className="sm:col-span-2" />
        <Field
          label="Description"
          name="description"
          error={errors.description}
          className="sm:col-span-2"
        />
        <Field
          label="Image URL (optional)"
          name="imageUrl"
          type="url"
          error={errors.imageUrl}
          className="sm:col-span-2"
        />
        <Field
          label="Starting price (cr)"
          name="startingPrice"
          type="number"
          min={0}
          defaultValue={100}
          error={errors.startingPrice}
        />
        <Field
          label="Minimum increment (cr)"
          name="minIncrement"
          type="number"
          min={1}
          defaultValue={5}
          error={errors.minIncrement}
        />
        <Field
          label="Starts at"
          name="startsAt"
          type="datetime-local"
          defaultValue={defaultStart}
          error={errors.startsAt}
        />
        <Field
          label="Duration (seconds)"
          name="durationS"
          type="number"
          min={10}
          defaultValue={60}
          error={errors.durationMs}
        />
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" loading={create.isPending}>
            Schedule auction
          </Button>
          {created && (
            <p role="status" className="text-sm text-winning">
              “{created}” scheduled.
            </p>
          )}
          {create.error && !(create.error instanceof ApiRequestError && create.error.fields) && (
            <p role="alert" className="text-sm text-outbid">
              {create.error.message}
            </p>
          )}
        </div>
      </form>
    </section>
  )
}

// ---------------------------------------------------------------- flagged users

const levelTone = {
  allow: 'neutral',
  throttle: 'scheduled',
  challenge: 'live',
  block: 'live',
} as const

function Timeline({ userId }: { userId: string }) {
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'risk', userId],
    queryFn: ({ signal }) =>
      request(`/admin/risk/users/${userId}/events`, { schema: riskEventsResponse, signal }),
  })
  if (isPending) return <Skeleton className="h-24" />
  if (!data?.events.length) return <p className="text-sm text-ink-muted">No stored decisions.</p>
  return (
    <ol className="flex flex-col gap-2" aria-label="Decision timeline, newest first">
      {data.events.slice(0, 20).map((e) => (
        <li key={e.id} className="rounded-xl border border-line p-3 text-sm">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone={levelTone[e.level]}>{e.level}</Badge>
            <span className="font-mono tabular-nums">score {e.score.toFixed(2)}</span>
            <time className="text-ink-muted" dateTime={e.createdAt}>
              {formatDateTime(e.createdAt)}
            </time>
          </div>
          <ul className="list-disc pl-5 text-ink-muted">
            {e.signals.map((s) => (
              <li key={s.name}>
                <span className="font-mono text-ink">{s.name}</span> ({s.score.toFixed(2)}):{' '}
                {s.reason}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  )
}

function FlaggedRow({ entry }: { entry: FlaggedUser }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const act = useMutation({
    mutationFn: (action: 'block' | 'clear') =>
      request(`/admin/users/${entry.user.id}/${action}`, { method: 'POST', schema: z.unknown() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'flagged'] })
    },
  })
  return (
    <>
      <tr>
        <td className="px-4 py-3">
          <p className="font-medium">{entry.user.displayName}</p>
          <p className="text-xs text-ink-muted">{entry.user.email}</p>
        </td>
        <td className="px-4 py-3 font-mono tabular-nums">{entry.riskScore.toFixed(2)}</td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            <Badge tone={levelTone[entry.level]}>{entry.level}</Badge>
            {entry.blocked && <Badge tone="live">account blocked</Badge>}
          </div>
        </td>
        <td className="max-w-md px-4 py-3 text-ink-muted">{entry.topReasons[0] ?? '—'}</td>
        <td className="px-4 py-3">
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              onClick={() => {
                setOpen((o) => !o)
              }}
            >
              Timeline
            </Button>
            {entry.blocked ? null : (
              <Button
                size="sm"
                variant="danger"
                loading={act.isPending && act.variables === 'block'}
                onClick={() => {
                  act.mutate('block')
                }}
              >
                Block
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              loading={act.isPending && act.variables === 'clear'}
              onClick={() => {
                act.mutate('clear')
              }}
            >
              Clear
            </Button>
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="bg-surface-muted/50 px-4 py-3">
            <Timeline userId={entry.user.id} />
          </td>
        </tr>
      )}
    </>
  )
}

function FlaggedUsers() {
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'flagged'],
    queryFn: ({ signal }) => request('/admin/risk/users', { schema: flaggedUsersResponse, signal }),
    refetchInterval: 5_000,
  })
  return (
    <section aria-labelledby="flagged-heading" className="flex flex-col gap-4">
      <h2 id="flagged-heading" className="flex items-center gap-2 text-lg font-semibold">
        <ShieldAlert className="size-5 text-urgent" aria-hidden />
        Flagged users
      </h2>
      {isPending ? (
        <Skeleton className="h-40" />
      ) : !data?.users.length ? (
        <EmptyState
          title="Nobody flagged"
          description="Run `pnpm bots` to see the engine at work."
        />
      ) : (
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">Risk</th>
                <th className="px-4 py-2 font-medium">Decision</th>
                <th className="px-4 py-2 font-medium">Top reason</th>
                <th className="px-4 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.users.map((u) => (
                <FlaggedRow key={u.user.id} entry={u} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- page

export default function AdminPage() {
  useDocumentTitle('Admin')
  const { data: session, isPending } = useSession()
  if (isPending) return <Skeleton className="h-64" />
  if (!session) return <Navigate to="/sign-in" replace state={{ from: '/admin' }} />
  if (session.user.role !== 'admin') {
    return (
      <EmptyState
        title="Admins only"
        action={
          <Link to="/auctions" className="font-semibold text-brand-600">
            Back to the auctions
          </Link>
        }
      />
    )
  }
  return (
    <div className={cn('flex flex-col gap-10')}>
      <h1 className="text-3xl font-extrabold tracking-tight">Admin</h1>
      <LiveMetrics />
      <FlaggedUsers />
      <CreateAuction />
    </div>
  )
}
