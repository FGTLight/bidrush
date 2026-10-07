import { resolve } from 'node:path'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/** Arbitrary constant shared by every instance: "BidRush migrations". */
const MIGRATION_LOCK_ID = 7_102_026

export const MIGRATIONS_DIR = resolve(process.cwd(), 'drizzle')

/**
 * Applies pending migrations. Several API instances may start together, so
 * the run is serialized with a Postgres advisory lock: the first instance
 * migrates, the others wait and then find nothing left to do.
 */
export async function runMigrations(databaseUrl: string, migrationsFolder = MIGRATIONS_DIR) {
  // A dedicated single connection: advisory locks belong to a session.
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined })
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_ID})`
    await migrate(drizzle({ client }), { migrationsFolder })
  } finally {
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => undefined)
    await client.end({ timeout: 5 })
  }
}
