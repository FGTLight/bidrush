import { useQuery } from '@tanstack/react-query'
import { Route, Routes } from 'react-router'
import { z } from 'zod'

import { request } from '@/lib/api'

const healthSchema = z.object({ status: z.literal('ok'), instance: z.string() })

/** Temporary landing page until the auction pages exist (step 6). */
function Landing() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => request('/health', { schema: healthSchema, signal }),
    retry: false,
  })

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6">
      <p className="font-mono text-sm font-bold uppercase tracking-widest text-brand-600">
        60 seconds · one winner
      </p>
      <h1 className="text-5xl font-extrabold tracking-tight">
        Bid<span className="text-brand-600">Rush</span>
      </h1>
      <p className="text-lg text-ink-muted">
        Real-time express auctions. The server decides every bid in milliseconds.
      </p>
      <p role="status" className="font-mono text-sm">
        API:{' '}
        {health.isPending ? (
          'checking…'
        ) : health.isSuccess ? (
          <span className="text-winning">online ({health.data.instance})</span>
        ) : (
          <span className="text-outbid">offline</span>
        )}
      </p>
    </main>
  )
}

export function App() {
  return (
    <Routes>
      <Route path="*" element={<Landing />} />
    </Routes>
  )
}
