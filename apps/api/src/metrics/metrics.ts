/**
 * Per-instance metrics, kept in memory: bids per second, bid latency
 * (frame arrival → ack sent) and connected sockets. Every instance also
 * publishes a snapshot to Redis so the admin dashboard sees the cluster.
 */
import type { MetricsSnapshot } from '@bidrush/shared'

import type { Redis } from '../redis'

const LATENCY_SAMPLES = 2_000
const RATE_WINDOW_MS = 10_000
const SNAPSHOT_TTL_MS = 10_000
const KEY_PREFIX = 'metrics:instance:'

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0
}

export class Metrics {
  /** Ring buffer of recent bid latencies (ms). */
  private readonly latencies: number[] = []
  private next = 0
  /** Completion times of recent bids, for the rate. */
  private recent: number[] = []
  bidsTotal = 0
  bidsAccepted = 0
  bidsRejected = 0
  connectedSockets = 0
  liveAuctions = 0

  constructor(readonly instanceId: string) {}

  recordBid(latencyMs: number, accepted: boolean, now = Date.now()) {
    if (this.latencies.length < LATENCY_SAMPLES) this.latencies.push(latencyMs)
    else this.latencies[this.next] = latencyMs
    this.next = (this.next + 1) % LATENCY_SAMPLES
    this.recent.push(now)
    this.bidsTotal += 1
    if (accepted) this.bidsAccepted += 1
    else this.bidsRejected += 1
  }

  snapshot(now = Date.now()): MetricsSnapshot {
    this.recent = this.recent.filter((t) => now - t <= RATE_WINDOW_MS)
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const round = (n: number) => Math.round(n * 10) / 10
    return {
      instanceId: this.instanceId,
      bidsPerSecond: round(this.recent.length / (RATE_WINDOW_MS / 1000)),
      bidLatencyMs: {
        p50: round(percentile(sorted, 50)),
        p95: round(percentile(sorted, 95)),
        p99: round(percentile(sorted, 99)),
      },
      connectedSockets: this.connectedSockets,
      liveAuctions: this.liveAuctions,
    }
  }

  /** Prometheus text exposition format. */
  prometheus(): string {
    const s = this.snapshot()
    const labels = `instance="${this.instanceId}"`
    return [
      '# HELP bidrush_bids_total Bids processed by this instance.',
      '# TYPE bidrush_bids_total counter',
      `bidrush_bids_total{${labels},result="accepted"} ${this.bidsAccepted}`,
      `bidrush_bids_total{${labels},result="rejected"} ${this.bidsRejected}`,
      '# HELP bidrush_bid_latency_ms Frame arrival to ack, over the last 2,000 bids.',
      '# TYPE bidrush_bid_latency_ms summary',
      `bidrush_bid_latency_ms{${labels},quantile="0.5"} ${s.bidLatencyMs.p50}`,
      `bidrush_bid_latency_ms{${labels},quantile="0.95"} ${s.bidLatencyMs.p95}`,
      `bidrush_bid_latency_ms{${labels},quantile="0.99"} ${s.bidLatencyMs.p99}`,
      '# HELP bidrush_bids_per_second Bids per second over the last 10 s.',
      '# TYPE bidrush_bids_per_second gauge',
      `bidrush_bids_per_second{${labels}} ${s.bidsPerSecond}`,
      '# HELP bidrush_connected_sockets Open WebSocket connections.',
      '# TYPE bidrush_connected_sockets gauge',
      `bidrush_connected_sockets{${labels}} ${s.connectedSockets}`,
      '',
    ].join('\n')
  }

  /** Shares this instance's snapshot with the cluster (expires if we die). */
  async publish(redis: Redis) {
    await redis.set(
      `${KEY_PREFIX}${this.instanceId}`,
      JSON.stringify(this.snapshot()),
      'PX',
      SNAPSHOT_TTL_MS,
    )
  }
}

/** Every live instance's latest snapshot. */
export async function clusterSnapshots(redis: Redis): Promise<MetricsSnapshot[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  if (keys.length === 0) return []
  const values = await redis.mget(...keys)
  return values
    .filter((v): v is string => v !== null)
    .map((v) => JSON.parse(v) as MetricsSnapshot)
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
}
