/**
 * `pnpm seed`: demo data. Idempotent: run it as often as you like.
 *
 * - Admin account (ADMIN_EMAIL / ADMIN_PASSWORD): dashboard and simulator.
 * - Three demo bidders with credits, to try the app in several tabs.
 * Live auctions come from the API's autopilot (AUTOPILOT=true), which keeps
 * a rolling schedule so there is always something to bid on.
 *
 * Passwords are reset to the values below on every run: demo accounts only.
 */
import { eq } from 'drizzle-orm'

import { hashPassword } from './auth/crypto'
import { loadConfig } from './config'
import { createDb } from './db/client'
import { runMigrations } from './db/migrate'
import { users } from './db/schema'
import { grantCredits, openAccounts } from './ledger/ledger'

const DEFAULT_ADMIN_PASSWORD = 'bidrush-admin-demo'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@bidrush.dev'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD
const DEMO_PASSWORD = 'bidrush-demo'

// The demo admin password is public (it's in the README): never on a real deployment.
if (
  process.env.NODE_ENV === 'production' &&
  (ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12)
) {
  console.error('In production, set ADMIN_PASSWORD to a private value of 12+ characters.')
  process.exit(1)
}

const accounts = [
  {
    email: ADMIN_EMAIL,
    displayName: 'Admin',
    role: 'admin' as const,
    password: ADMIN_PASSWORD,
    credits: 10_000,
  },
  ...['Alice', 'Bob', 'Carol'].map((name) => ({
    email: `${name.toLowerCase()}@bidrush.dev`,
    displayName: name,
    role: 'user' as const,
    password: DEMO_PASSWORD,
    credits: 5_000,
  })),
]

const config = loadConfig()
await runMigrations(config.databaseUrl)
const { db, close } = createDb(config.databaseUrl, { max: 2 })

for (const account of accounts) {
  const passwordHash = await hashPassword(account.password)
  const [existing] = await db.select().from(users).where(eq(users.email, account.email))
  if (existing) {
    await db
      .update(users)
      .set({ passwordHash, role: account.role, blockedAt: null })
      .where(eq(users.id, existing.id))
    console.log(`updated  ${account.email}`)
    continue
  }
  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: account.email,
        passwordHash,
        displayName: account.displayName,
        role: account.role,
      })
      .returning()
    if (!user) throw new Error('user not created')
    await openAccounts(tx, user.id)
    await grantCredits(tx, user.id, account.credits, 'Demo credits')
  })
  console.log(`created  ${account.email}`)
}

const shownPassword = process.env.NODE_ENV === 'production' ? '(ADMIN_PASSWORD)' : ADMIN_PASSWORD
console.log(`\nadmin: ${ADMIN_EMAIL} / ${shownPassword}`)
console.log(`demo bidders: alice@, bob@, carol@bidrush.dev / ${DEMO_PASSWORD}`)
await close()
