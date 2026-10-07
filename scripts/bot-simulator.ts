/**
 * Bot simulator: scripted bots vs. simulated humans in one live auction,
 * then prints what the anti-bot engine concluded about each of them.
 *
 *   docker compose up -d && pnpm seed && pnpm bots
 *
 * Options (env): BIDRUSH_URL (default http://localhost:8080),
 * ADMIN_EMAIL / ADMIN_PASSWORD (see `pnpm seed`), SIM_SECONDS (default 45; three auctions
 * run 45, 55 and 65 s).
 *
 * Every client is a real account with its own WebSocket. Bots deliberately
 * spoof what a script can spoof (they claim real clicks and a normal
 * browser) so the demo shows which detections survive that.
 */
import { randomUUID } from 'node:crypto'

import {
  type Auction,
  type BrowserSignals,
  type FlaggedUser,
  type ServerMessage,
  serverMessageSchema,
} from '@bidrush/shared'
import WebSocket from 'ws'

const BASE = process.env.BIDRUSH_URL ?? 'http://localhost:8080'
const API = `${BASE}/api`
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`
const ORIGIN = { origin: BASE }
const SECONDS = Number(process.env.SIM_SECONDS ?? 45)
const RUN = Date.now().toString(36)

// ---------------------------------------------------------------- personas

type Kind = 'human' | 'metronome' | 'sniper' | 'headless' | 'closer' | 'farm' | 'honeypot'

const random = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
/** A random element, or undefined for an empty list. */
const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(Math.random() * xs.length)]

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function browser(overrides: Partial<BrowserSignals> = {}): BrowserSignals {
  return {
    userAgent: CHROME_UA,
    webdriver: false,
    languages: pick([
      ['en-US', 'en'],
      ['es-ES', 'es', 'en'],
      ['pt-BR', 'pt'],
    ]),
    timezone: 'UTC',
    timezoneOffset: 0,
    screen: pick([
      { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1 },
      { width: 1440, height: 900, colorDepth: 30, pixelRatio: 2 },
      { width: 2560, height: 1440, colorDepth: 24, pixelRatio: 1 },
    ]),
    hardwareConcurrency: pick([4, 8, 12, 16]),
    touchPoints: 0,
    pluginsCount: 5,
    headlessHints: [],
    canvasHash: randomUUID().replaceAll('-', '').slice(0, 24),
    ...overrides,
  }
}

const farmDevice = browser({ canvasHash: 'f4rmf4rmf4rmf4rmf4rmf4rm', hardwareConcurrency: 4 })

interface Persona {
  name: string
  kind: Kind
  signals: BrowserSignals | null
}

const personas: Persona[] = [
  ...['Ana', 'Ben', 'Carla', 'Dev', 'Elif'].map((name) => ({
    name,
    kind: 'human' as const,
    signals: browser(),
  })),
  { name: 'Metronome', kind: 'metronome', signals: browser() },
  { name: 'Sniper', kind: 'sniper', signals: browser() },
  {
    name: 'Headless',
    kind: 'headless',
    signals: browser({
      webdriver: true,
      userAgent: CHROME_UA.replace('Chrome/', 'HeadlessChrome/'),
      pluginsCount: 0,
      headlessHints: ['no-window-chrome', 'no-plugins'],
    }),
  },
  { name: 'Closer', kind: 'closer', signals: browser() },
  ...[1, 2, 3, 4].map((i) => ({ name: `Farm-${i}`, kind: 'farm' as const, signals: farmDevice })),
  { name: 'FormFiller', kind: 'honeypot', signals: browser() },
]

// ---------------------------------------------------------------- HTTP

interface Session {
  cookie: string
  csrf: string
  userId: string
}

async function auth(path: string, body: object): Promise<Session> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { csrfToken: string; user: { id: string } }
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('no session cookie')
  return { cookie, csrf: json.csrfToken, userId: json.user.id }
}

async function adminRequest<T>(admin: Session, path: string, body?: object): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...ORIGIN,
      cookie: admin.cookie,
      'x-csrf-token': admin.csrf,
      ...(body && { 'content-type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

// ---------------------------------------------------------------- simulated client

class SimClient {
  ws!: WebSocket
  readonly auctions = new Map<string, Auction>()
  readonly ended = new Set<string>()
  accepted = 0
  rejected = new Map<string, number>()
  private lastPriceShownAt = Date.now()
  private readonly closingBidFor = new Map<string, string>()
  /** A person has one intention at a time, not one per price change. */
  private reacting = false
  private timers: NodeJS.Timeout[] = []

  constructor(
    readonly persona: Persona,
    readonly session: Session,
  ) {}

  private leading(a: Auction) {
    return a.leader?.id === this.session.userId
  }

  private live() {
    return [...this.auctions.values()].filter((a) => a.status === 'live' && !this.ended.has(a.id))
  }

  async connect(auctionIds: string[]) {
    this.ws = new WebSocket(WS_URL, { headers: { ...ORIGIN, cookie: this.session.cookie } })
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => {
        resolve()
      })
      this.ws.once('error', reject)
    })
    this.ws.on('message', (raw: Buffer) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(raw.toString()))
      if (parsed.success) this.onMessage(parsed.data)
    })
    if (this.persona.signals) this.send({ type: 'hello', signals: this.persona.signals })
    for (const auctionId of auctionIds) this.send({ type: 'subscribe', auctionId })
  }

  private send(message: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  private onMessage(m: ServerMessage) {
    switch (m.type) {
      case 'auction_snapshot':
      case 'auction_started':
        this.auctions.set(m.auction.id, m.auction)
        break
      case 'bid_placed': {
        const a = this.auctions.get(m.bid.auctionId)
        if (!a) break
        const updated = {
          ...a,
          currentPrice: m.currentPrice,
          leader: m.bid.bidder,
          endsAt: m.endsAt,
        }
        this.auctions.set(a.id, updated)
        this.lastPriceShownAt = Date.now()
        this.react(updated)
        break
      }
      case 'auction_ended':
        this.ended.add(m.auctionId)
        break
      case 'bid_ack':
        if (m.status === 'accepted') this.accepted += 1
        else this.rejected.set(m.code, (this.rejected.get(m.code) ?? 0) + 1)
        break
      default:
    }
  }

  private secondsLeft(a: Auction) {
    return (Date.parse(a.endsAt) - Date.now()) / 1000
  }

  private bid(auctionId: string, extraSteps = 0) {
    const a = this.auctions.get(auctionId)
    if (!a || a.status !== 'live' || this.ended.has(a.id) || this.leading(a)) return
    const min = a.leader ? a.currentPrice + a.minIncrement : a.startingPrice
    const spoofsClicks = this.persona.kind !== 'human' // humans really click
    this.send({
      type: 'bid',
      bidId: randomUUID(),
      auctionId: a.id,
      amount: min + extraSteps * a.minIncrement,
      interaction: {
        // Bots claim a click too: the engine must not depend on honesty.
        trustedEvents: spoofsClicks ? 1 : Math.ceil(random(1, 4)),
        honeypot: this.persona.kind === 'honeypot' ? 'http://cheap-watches.example' : '',
        reactionMs: Date.now() - this.lastPriceShownAt,
      },
    })
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms))
  }

  /** Decide to bid after a human-scale delay, unless already about to. */
  private intend(auctionId: string, ms: number, extraSteps = 0) {
    if (this.reacting) return
    this.reacting = true
    this.later(ms, () => {
      this.reacting = false
      this.bid(auctionId, extraSteps)
    })
  }

  /** Called when an auction's price changes. */
  private react(a: Auction) {
    if (this.leading(a) || this.ended.has(a.id)) return
    switch (this.persona.kind) {
      case 'human':
        // Not every human answers every bid, and never instantly; but the
        // last seconds are a bidding war, so they answer far more often.
        if (Math.random() < (this.secondsLeft(a) < 6 ? 0.85 : 0.45)) {
          this.intend(a.id, random(700, 2_600), Math.floor(random(0, 3)))
        }
        break
      case 'sniper':
        this.later(random(25, 45), () => {
          this.bid(a.id)
        })
        break
      case 'headless':
      case 'farm':
      case 'honeypot':
        if (Math.random() < 0.3) this.intend(a.id, random(1_200, 3_500))
        break
      default:
    }
  }

  /** Behaviour that doesn't wait for price changes. */
  start() {
    if (this.persona.kind === 'metronome') {
      this.timers.push(
        setInterval(() => {
          const target = pick(this.live())
          if (target) this.bid(target.id)
        }, 800),
      )
    }
    if (this.persona.kind === 'closer') {
      // Fires at exactly 1.5 s before each (possibly extended) end.
      this.timers.push(
        setInterval(() => {
          for (const a of this.live()) {
            const left = Date.parse(a.endsAt) - Date.now()
            if (left > 1_440 && left < 1_560 && this.closingBidFor.get(a.id) !== a.endsAt) {
              this.closingBidFor.set(a.id, a.endsAt)
              this.bid(a.id)
            }
          }
        }, 20),
      )
    }
    if (this.persona.kind === 'human' || this.persona.kind === 'farm') {
      const first = pick(this.live())
      if (first) this.intend(first.id, random(500, 3_000))
    }
  }

  stop() {
    for (const t of this.timers) clearTimeout(t)
    this.ws.close()
  }
}

// ---------------------------------------------------------------- run

function table(rows: string[][]) {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? []
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join('  ')).join('\n')
}

async function main() {
  console.log(`BidRush bot simulator → ${BASE} (run ${RUN})\n`)
  const admin = await auth('/auth/sign-in', {
    email: process.env.ADMIN_EMAIL ?? 'admin@bidrush.dev',
    password: process.env.ADMIN_PASSWORD ?? 'bidrush-admin-demo',
  })

  // Several auctions at once with staggered ends, like the real site: a
  // closing-time sniper shows its pattern across auctions, not within one.
  const startsAt = new Date(Date.now() + 4_000).toISOString()
  const auctions: Auction[] = []
  for (const [i, item] of ['Vintage camera', 'Mechanical keyboard', 'Signed vinyl'].entries()) {
    const { auction } = await adminRequest<{ auction: Auction }>(admin, '/admin/auctions', {
      title: `${item} (simulation ${RUN})`,
      description: 'Scripted bots vs simulated humans.',
      // Low prices so every bidder can afford to stay in until the soft close.
      startingPrice: 10,
      minIncrement: 1,
      startsAt,
      durationMs: (SECONDS + i * 10) * 1_000,
    })
    auctions.push(auction)
  }
  console.log(
    `${auctions.length} auctions start in 4 s and run ${SECONDS}–${SECONDS + 20} s (+ soft-close extensions)\n`,
  )

  const clients: SimClient[] = []
  for (const persona of personas) {
    const session = await auth('/auth/sign-up', {
      email: `sim-${RUN}-${persona.name.toLowerCase()}@bidrush.dev`,
      password: 'simulated-password',
      displayName: persona.name,
    })
    const client = new SimClient(persona, session)
    await client.connect(auctions.map((a) => a.id))
    clients.push(client)
  }

  // Wait for the start, run, and wait for the server to close every auction.
  await new Promise((r) => setTimeout(r, Date.parse(startsAt) - Date.now() + 300))
  for (const c of clients) c.start()
  const deadline = Date.now() + (SECONDS + 20 + 45) * 1_000
  const watcher = clients[0]
  while (watcher && watcher.ended.size < auctions.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  for (const c of clients) c.stop()
  await new Promise((r) => setTimeout(r, 1_500)) // let the audit writes land

  // Only this run's participants: other flagged users must not crowd them out.
  const ids = clients.map((c) => c.session.userId).join(',')
  const { users } = await adminRequest<{ users: FlaggedUser[] }>(
    admin,
    `/admin/risk/users?ids=${ids}`,
  )
  const verdicts = new Map(users.map((u) => [u.user.id, u]))

  const rows = [['participant', 'really', 'accepted', 'rejected', 'engine verdict', 'top reason']]
  let botsCaught = 0
  let bots = 0
  let humansFlagged = 0
  for (const c of clients) {
    const v = verdicts.get(c.session.userId)
    const isBot = c.persona.kind !== 'human'
    if (isBot) bots += 1
    if (isBot && v) botsCaught += 1
    if (!isBot && v) humansFlagged += 1
    rows.push([
      c.persona.name,
      c.persona.kind,
      String(c.accepted),
      [...c.rejected].map(([code, n]) => `${code}×${n}`).join(' ') || '-',
      v ? `${v.level.toUpperCase()} (${v.riskScore.toFixed(2)})` : 'clean',
      v?.topReasons[0]?.slice(0, 72) ?? '',
    ])
  }
  console.log(table(rows))
  console.log(
    `\nbots flagged: ${botsCaught}/${bots} · humans flagged: ${humansFlagged}/${clients.length - bots}`,
  )
  console.log('Review each decision in the admin dashboard → Flagged users.')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
