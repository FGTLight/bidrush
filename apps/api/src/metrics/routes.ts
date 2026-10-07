import { timingSafeEqual } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import { requireAdmin } from '../auth/plugin'
import type { Config } from '../config'
import { HttpError } from '../errors'
import type { Redis } from '../redis'
import { clusterSnapshots, type Metrics } from './metrics'

function tokenMatches(expected: string, header: string | undefined) {
  const given = Buffer.from(header?.replace(/^Bearer /, '') ?? '')
  const want = Buffer.from(expected)
  return given.length === want.length && timingSafeEqual(given, want)
}

export async function metricsRoutes(
  app: FastifyInstance,
  { config, metrics, redis }: { config: Config; metrics: Metrics; redis: Redis },
) {
  /** Prometheus scrape endpoint for this instance. */
  app.get('/metrics', async (req, reply) => {
    if (config.metricsToken && !tokenMatches(config.metricsToken, req.headers.authorization)) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Metrics token required.')
    }
    return reply.type('text/plain; version=0.0.4').send(metrics.prometheus())
  })

  /** The whole cluster for the admin dashboard: every instance's latest snapshot. */
  app.get('/admin/metrics', { preHandler: requireAdmin }, async () => {
    const instances = await clusterSnapshots(redis)
    const sum = (f: (s: (typeof instances)[number]) => number) =>
      instances.reduce((total, s) => total + f(s), 0)
    return {
      serverTime: Date.now(),
      instances,
      totals: {
        bidsPerSecond: Math.round(sum((s) => s.bidsPerSecond) * 10) / 10,
        connectedSockets: sum((s) => s.connectedSockets),
        liveAuctions: instances[0]?.liveAuctions ?? 0,
        // Worst instance: an honest upper bound without merging histograms.
        p95LatencyMs: Math.max(0, ...instances.map((s) => s.bidLatencyMs.p95)),
      },
    }
  })
}
