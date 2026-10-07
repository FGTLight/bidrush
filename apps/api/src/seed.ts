/**
 * `pnpm seed`: demo data. Idempotent: run it as often as you like.
 *
 * Creates the admin account (ADMIN_EMAIL / ADMIN_PASSWORD) used by the
 * dashboard and the bot simulator.
 */
import { eq } from 'drizzle-orm'

import { hashPassword } from './auth/crypto'
import { loadConfig } from './config'
import { createDb } from './db/client'
import { runMigrations } from './db/migrate'
import { users } from './db/schema'
import { grantCredits, openAccounts } from './ledger/ledger'

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@bidrush.dev'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'bidrush-admin-demo'

const config = loadConfig()
await runMigrations(config.databaseUrl)
const { db, close } = createDb(config.databaseUrl, { max: 2 })

const [existing] = await db.select().from(users).where(eq(users.email, ADMIN_EMAIL))
if (existing) {
  await db.update(users).set({ role: 'admin', blockedAt: null }).where(eq(users.id, existing.id))
  console.log(`admin ${ADMIN_EMAIL} already exists (role ensured)`)
} else {
  const passwordHash = await hashPassword(ADMIN_PASSWORD)
  await db.transaction(async (tx) => {
    const [admin] = await tx
      .insert(users)
      .values({ email: ADMIN_EMAIL, passwordHash, displayName: 'Admin', role: 'admin' })
      .returning()
    if (!admin) throw new Error('admin not created')
    await openAccounts(tx, admin.id)
    await grantCredits(tx, admin.id, 10_000, 'Admin demo credits')
  })
  console.log(`admin ${ADMIN_EMAIL} created`)
}

await close()
