/**
 * Anti-bot engine: gathers a bid's context (one Redis pipeline), scores it
 * with the pure signals, decides, and records the decision.
 *
 * Actions, mildest first: allow → throttle (delay the bid, so it loses
 * races) → challenge (proof-of-work before bidding again) → block. Every
 * decision is logged with its reasons, and every non-trivial one is stored
 * in Postgres, so nobody is ever blocked silently and admins can audit or
 * overturn it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { BrowserSignals, InteractionSignals } from '@bidrush/shared'
import { and, count, eq, gte, isNull, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

import type { Db } from '../db/client'
import { riskEvents, userRisk, users } from '../db/schema'
import type { Redis } from '../redis'
import type { AntiBotConfig } from './config'
import { combine, decide, scoreSignals, withMemory } from './score'
import type { BidContext, Decision } from './types'

const K = {
  bids: (u: string) => `ab:bids:${u}`,
  reactions: (u: string) => `ab:react:${u}`,
  outbid: (u: string, a: string) => `ab:outbid:${u}:${a}`,
  closing: (u: string) => `ab:close:${u}`,
  ends: (a: string) => `ab:ends:${a}`,
  rateUser: (u: string) => `ab:rate:u:${u}`,
  rateIp: (ip: string) => `ab:rate:ip:${ip}`,
  rateDevice: (fp: string) => `ab:rate:d:${fp}`,
  device: (fp: string) => `ab:device:${fp}`,
  memory: (u: string) => `ab:score:${u}`,
  memoryReasons: (u: string) => `ab:reasons:${u}`,
  pass: (u: string) => `ab:pass:${u}`,
  challenge: (id: string) => `ab:challenge:${id}`,
}

const HISTORY = 20
const HOUR_MS = 3_600_000

export interface BidAttempt {
  userId: string
  auctionId: string
  bidId: string
  ip: string
  /**
   * When the frame arrived. Timing signals must use this, not the time of
   * evaluation: a throttled user's queued bids would otherwise show the
   * engine's own (regular) delays and look machine-made.
   */
  receivedAt: number
  interaction: InteractionSignals
  browser: BrowserSignals | null
}

export interface Evaluation extends Decision {
  /** Above the hard per-second limit: refuse as RATE_LIMITED, whatever the score. */
  rateLimited: boolean
  fingerprint: string | null
}

/** A stable hash of what the browser reported: identifies a device, not a person. */
export function fingerprintOf(b: BrowserSignals | null): string | null {
  if (!b) return null
  const material = JSON.stringify([
    b.canvasHash,
    b.userAgent,
    b.screen,
    b.timezone,
    b.languages,
    b.hardwareConcurrency,
    b.deviceMemory,
    b.touchPoints,
  ])
  return createHash('sha256').update(material).digest('hex').slice(0, 20)
}

const toNumbers = (value: unknown) =>
  Array.isArray(value) ? value.map(Number).filter((n) => Number.isFinite(n)) : []

export class AntiBotEngine {
  /** Audit writes still in flight (they run off the bid's hot path). */
  private readonly pending = new Set<Promise<void>>()

  constructor(
    private readonly redis: Redis,
    private readonly db: Db,
    readonly config: AntiBotConfig,
    private readonly log: FastifyBaseLogger,
  ) {}

  get enabled() {
    return this.config.mode !== 'off'
  }

  /** Scores one bid attempt. Records its timing as a side effect. */
  async evaluate(attempt: BidAttempt): Promise<Evaluation> {
    const now = attempt.receivedAt
    const { userId: u, auctionId: a, ip } = attempt
    const fp = fingerprintOf(attempt.browser)
    const member = `${now}:${randomUUID().slice(0, 8)}`

    // One round trip: read the history, then append this attempt to it.
    const pipe = this.redis.multi()
    pipe.lrange(K.bids(u), 0, HISTORY - 1) // 0
    pipe.lrange(K.reactions(u), 0, 9) // 1
    pipe.lrange(K.closing(u), 0, 9) // 2
    pipe.lrange(K.memoryReasons(u), 0, 2) // 3
    pipe.get(K.ends(a)) // 4
    pipe.hgetall(K.memory(u)) // 5
    pipe.exists(K.pass(u)) // 6
    for (const key of [K.rateUser(u), K.rateIp(ip), ...(fp ? [K.rateDevice(fp)] : [])]) {
      pipe.zadd(key, now, member)
      pipe.zremrangebyscore(key, 0, now - 60_000)
      pipe.pexpire(key, 60_000)
    }
    pipe.zcount(K.rateUser(u), now - 1_000, '+inf') // 7 + 3n
    pipe.zcard(K.rateUser(u))
    pipe.zcard(K.rateIp(ip))
    if (fp) {
      pipe.zcard(K.rateDevice(fp))
      pipe.sadd(K.device(fp), u)
      pipe.pexpire(K.device(fp), 24 * HOUR_MS)
      pipe.scard(K.device(fp))
    }
    pipe.lpush(K.bids(u), now)
    pipe.ltrim(K.bids(u), 0, HISTORY - 1)
    pipe.pexpire(K.bids(u), HOUR_MS)
    const results = (await pipe.exec()) ?? []
    const value = (i: number): unknown => results[i]?.[1]

    const rateBase = 7 + (fp ? 9 : 6)
    const userPerSecond = Number(value(rateBase))
    const userPerMinute = Number(value(rateBase + 1))
    const ipPerMinute = Number(value(rateBase + 2))
    const devicePerMinute = fp ? Number(value(rateBase + 3)) : 0
    const accountsOnDevice = fp ? Number(value(rateBase + 6)) : 1

    // Reaction samples come from accepted bids only (see noteAccepted).
    const reactionTimes = toNumbers(value(1))
    const followUps: Promise<unknown>[] = []
    // Offset before the close, for bids in the closing window.
    const closingOffsets = toNumbers(value(2))
    const endsAt = Number(value(4))
    if (endsAt > 0 && endsAt - now <= this.config.timing.closingWindowMs && endsAt > now) {
      closingOffsets.unshift(endsAt - now)
      followUps.push(this.pushCapped(K.closing(u), endsAt - now))
    }

    const ctx: BidContext = {
      userId: u,
      auctionId: a,
      ip,
      nowMs: now,
      interaction: attempt.interaction,
      browser: attempt.browser,
      fingerprint: fp,
      accountsOnDevice,
      recentBidTimes: toNumbers(value(0)),
      reactionTimes,
      closingOffsets,
      rate: { userPerSecond, userPerMinute, ipPerMinute, devicePerMinute },
    }

    const signals = scoreSignals(ctx, this.config)
    const memory = value(5) as Record<string, string> | null
    const previous =
      memory?.score !== undefined ? { score: Number(memory.score), atMs: Number(memory.at) } : null
    const current = combine(signals.map((s) => s.score))
    const score = withMemory(current, previous, now, this.config.memoryHalfLifeMs)
    const fresh = [...signals]
    if (score > current) {
      // The decision rests on earlier evidence: say so, quoting it.
      const earlier = (value(3) as string[] | null)?.[0] ?? 'earlier suspicious activity'
      signals.unshift({
        name: 'recent_history',
        score,
        reason: `still under review (decaying) after: ${earlier}`,
      })
    }
    const decision = decide(score, signals, this.config, { hasPass: Number(value(6)) === 1 })

    followUps.push(this.remember(u, score, now, fresh))
    await Promise.all(followUps)

    return {
      ...decision,
      fingerprint: fp,
      rateLimited: userPerSecond > this.config.rate.userPerSecondHard,
    }
  }

  /** Remembers the score, and the reasons when this attempt produced new ones. */
  private async remember(userId: string, score: number, at: number, fresh: { reason: string }[]) {
    const pipe = this.redis
      .multi()
      .hset(K.memory(userId), { score, at })
      .pexpire(K.memory(userId), HOUR_MS)
    if (fresh.length > 0) {
      pipe
        .del(K.memoryReasons(userId))
        .rpush(K.memoryReasons(userId), ...fresh.slice(0, 3).map((s) => s.reason))
        .pexpire(K.memoryReasons(userId), HOUR_MS)
    }
    await pipe.exec()
  }

  private async pushCapped(key: string, n: number) {
    await this.redis.multi().lpush(key, n).ltrim(key, 0, 9).pexpire(key, HOUR_MS).exec()
  }

  /** Called when a user's bid is beaten: starts their reaction stopwatch. */
  async noteOutbid(userId: string, auctionId: string, at = Date.now()) {
    if (!this.enabled) return
    await this.redis.set(K.outbid(userId, auctionId), at, 'PX', 60_000)
  }

  /**
   * Called when a user's bid is accepted: stops the stopwatch. Only accepted
   * bids count, because their amount proves the bidder saw the new price. A
   * bid decided earlier that merely arrives right after the outbid is
   * refused as too low, and must not look like a superhuman reaction.
   */
  async noteAccepted(userId: string, auctionId: string, receivedAt: number) {
    if (!this.enabled) return
    const outbidAt = Number(await this.redis.getdel(K.outbid(userId, auctionId)))
    if (outbidAt > 0 && receivedAt > outbidAt) {
      await this.pushCapped(K.reactions(userId), receivedAt - outbidAt)
    }
  }

  /** Keeps the auction's current end time at hand for the closing-offset signal. */
  async noteEndsAt(auctionId: string, endsAt: Date) {
    if (!this.enabled) return
    const ttl = Math.max(1_000, endsAt.getTime() - Date.now() + 60_000)
    await this.redis.set(K.ends(auctionId), endsAt.getTime(), 'PX', ttl)
  }

  /** After an admin clears a user: drop the remembered risk and any pass. */
  async forget(userId: string) {
    await this.redis.del(
      K.memory(userId),
      K.memoryReasons(userId),
      K.pass(userId),
      K.bids(userId),
      K.reactions(userId),
      K.closing(userId),
    )
  }

  // ---------------------------------------------------------------- proof-of-work

  async issueChallenge(userId: string) {
    const id = randomUUID()
    const prefix = randomBytes(8).toString('hex')
    const { difficulty, ttlMs } = this.config.challenge
    await this.redis.set(K.challenge(id), `${userId}:${prefix}:${difficulty}`, 'PX', ttlMs)
    return { type: 'challenge' as const, id, prefix, difficulty }
  }

  /** Single use. A valid answer grants a pass that downgrades "challenge" to "throttle". */
  async verifyChallenge(userId: string, answer: { id: string; nonce: string }): Promise<boolean> {
    const stored = await this.redis.getdel(K.challenge(answer.id))
    if (!stored) return false
    const [owner, prefix, difficulty] = stored.split(':')
    if (owner !== userId || !prefix) return false
    const hash = createHash('sha256')
      .update(prefix + answer.nonce)
      .digest('hex')
    if (!hash.startsWith('0'.repeat(Number(difficulty)))) return false
    await this.redis.set(K.pass(userId), 1, 'PX', this.config.challenge.passMs)
    return true
  }

  // ---------------------------------------------------------------- audit trail

  /** Records a decision in the background; failures are logged, never thrown. */
  recordInBackground(attempt: BidAttempt, evaluation: Evaluation) {
    const task: Promise<void> = this.record(attempt, evaluation)
      .catch((err: unknown) => {
        this.log.error({ err }, 'antibot record failed')
      })
      .finally(() => {
        this.pending.delete(task)
      })
    this.pending.add(task)
  }

  /** Waits for in-flight audit writes (graceful shutdown, tests). */
  async drain() {
    await Promise.all([...this.pending])
  }

  /**
   * Logs every decision and stores the meaningful ones. Repeated blocks
   * within the window block the account itself (also recorded).
   */
  async record(attempt: BidAttempt, evaluation: Evaluation) {
    const { level, score, signals } = evaluation
    const entry = {
      userId: attempt.userId,
      auctionId: attempt.auctionId,
      bidId: attempt.bidId,
      score: Number(score.toFixed(3)),
      level,
      reasons: signals.map((s) => `${s.name}: ${s.reason}`),
      mode: this.config.mode,
    }
    if (level === 'allow') {
      this.log.debug(entry, 'antibot decision')
      if (score < 0.2) return
    } else {
      this.log.warn(entry, 'antibot decision')
    }

    await this.db.insert(riskEvents).values({
      userId: attempt.userId,
      auctionId: attempt.auctionId,
      bidId: attempt.bidId,
      score: entry.score,
      level,
      signals: signals.map(({ name, score: s, reason }) => ({
        name,
        score: Number(s.toFixed(3)),
        reason,
      })),
      ip: attempt.ip,
      fingerprint: evaluation.fingerprint,
    })
    if (level === 'allow') return

    const lastEventAt = new Date()
    const topReasons = signals.slice(0, 3).map((s) => s.reason)
    await this.db
      .insert(userRisk)
      .values({ userId: attempt.userId, score: entry.score, level, topReasons, lastEventAt })
      .onConflictDoUpdate({
        target: userRisk.userId,
        set: { score: entry.score, level, topReasons, lastEventAt, clearedAt: null },
      })

    if (level === 'block' && this.config.mode === 'enforce') await this.maybeAutoBlock(attempt)
  }

  private async maybeAutoBlock(attempt: BidAttempt) {
    const { decisions, windowMs } = this.config.autoBlock
    const [row] = await this.db
      .select({ n: count() })
      .from(riskEvents)
      .where(
        and(
          eq(riskEvents.userId, attempt.userId),
          eq(riskEvents.level, 'block'),
          gte(riskEvents.createdAt, new Date(Date.now() - windowMs)),
        ),
      )
    if ((row?.n ?? 0) < decisions) return
    const blocked = await this.db
      .update(users)
      .set({ blockedAt: sql`now()` })
      .where(and(eq(users.id, attempt.userId), isNull(users.blockedAt)))
      .returning({ id: users.id })
    if (blocked.length === 0) return
    await this.db
      .update(riskEvents)
      .set({ autoBlocked: true })
      .where(
        sql`${riskEvents.id} = (select max(id) from risk_events where user_id = ${attempt.userId})`,
      )
    this.log.warn({ userId: attempt.userId, decisions }, 'antibot auto-blocked account')
  }
}
