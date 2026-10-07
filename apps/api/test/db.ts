/** Helpers for integration tests that talk to the real test database. */
import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, expect } from 'vitest'

import { createDb, type Executor } from '../src/db/client'
import { pgError, type PgError } from '../src/db/errors'
import { auctions, users } from '../src/db/schema'
import { clearSystemAccountCache, grantCredits, openAccounts } from '../src/ledger/ledger'
import { TEST_DATABASE_URL } from './env'

/** A pool for the current test file, closed automatically. */
export function useTestDb(max = 10) {
  const handle = createDb(TEST_DATABASE_URL, { max })
  afterAll(() => handle.close())
  return handle
}

/** Empties every table and recreates the system ledger accounts. */
export async function resetDb(db: Executor) {
  await db.execute(sql`
    truncate users, sessions, auctions, bids, auction_participants,
      ledger_entries, ledger_transactions, ledger_accounts
    restart identity cascade
  `)
  await db.execute(sql`insert into ledger_accounts (kind) values ('issuance'), ('revenue')`)
  clearSystemAccountCache()
}

let userSeq = 0

/** A user with ledger accounts and, optionally, starting credits. */
export async function createUser(
  db: Executor,
  { credits = 0, role = 'user' }: { credits?: number; role?: 'user' | 'admin' } = {},
) {
  userSeq += 1
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: `user${userSeq}-${randomUUID().slice(0, 6)}@test.dev`,
        passwordHash: 'not-a-real-hash',
        displayName: `User ${userSeq}`,
        role,
      })
      .returning()
    if (!user) throw new Error('user not created')
    await openAccounts(tx, user.id)
    if (credits > 0) await grantCredits(tx, user.id, credits, 'test credits')
    return user
  })
}

export async function createAuction(
  db: Executor,
  overrides: Partial<typeof auctions.$inferInsert> = {},
) {
  const now = Date.now()
  const [auction] = await db
    .insert(auctions)
    .values({
      title: 'Test auction',
      status: 'live',
      startingPrice: 100,
      minIncrement: 10,
      currentPrice: overrides.startingPrice ?? 100,
      startsAt: new Date(now - 1_000),
      endsAt: new Date(now + 60_000),
      softCloseWindowMs: 5_000,
      extensionMs: 5_000,
      maxExtensionMs: 30_000,
      ...overrides,
    })
    .returning()
  if (!auction) throw new Error('auction not created')
  return auction
}

/**
 * The ledger's global invariants. Call at the end of any test that moves
 * credits: they must hold whatever happened in between.
 */
export async function expectLedgerConsistent(db: Executor) {
  const [totals] = await db.execute<{ total: string; unbalanced: string; drifted: string }>(sql`
    select
      (select coalesce(sum(amount), 0) from ledger_entries) as total,
      (select count(*) from (
         select transaction_id from ledger_entries
         group by transaction_id having sum(amount) <> 0) t) as unbalanced,
      (select count(*) from ledger_accounts a
         where a.balance <> coalesce(
           (select sum(e.amount) from ledger_entries e where e.account_id = a.id), 0)) as drifted
  `)
  expect(Number(totals?.total), 'the ledger sums to zero').toBe(0)
  expect(Number(totals?.unbalanced), 'every transaction balances').toBe(0)
  expect(Number(totals?.drifted), 'cached balances match the entries').toBe(0)

  const [negative] = await db.execute<{ n: string }>(sql`
    select count(*) as n from ledger_accounts where kind <> 'issuance' and balance < 0
  `)
  expect(Number(negative?.n), 'no negative user balance').toBe(0)
}

/** Awaits a query that must fail, and returns the underlying Postgres error. */
export async function pgErrorOf(query: PromiseLike<unknown>): Promise<PgError> {
  try {
    await query
  } catch (error) {
    const pg = pgError(error)
    if (pg) return pg
    throw error
  }
  throw new Error('Expected the query to fail')
}
