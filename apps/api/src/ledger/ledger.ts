/**
 * Credits ledger: the only module that moves credits.
 *
 * Every movement is a balanced transaction (entries sum to zero) between
 * accounts. Postgres enforces the invariants (see drizzle/0001_*.sql): no
 * user balance below zero, balanced transactions, append-only history, and
 * at most one reserve/release per bid and one settlement per auction.
 */
import type { LedgerEntry, Wallet } from '@bidrush/shared'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import type { Executor, Tx } from '../db/client'
import { isCheckViolation } from '../db/errors'
import { auctions, ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema'

export class InsufficientCreditsError extends Error {
  constructor() {
    super('Not enough available credits')
    this.name = 'InsufficientCreditsError'
  }
}

type TxKind = (typeof ledgerTransactions.$inferInsert)['kind']

export interface UserAccounts {
  available: number
  reserved: number
}

interface Posting {
  kind: TxKind
  auctionId?: string | null
  bidId?: string | null
  memo?: string | null
  entries: { accountId: number; amount: number }[]
}

/**
 * Writes one balanced transaction. Returns its id, or null when the
 * database says it already exists (an idempotent retry).
 */
async function post(tx: Tx, posting: Posting): Promise<number | null> {
  const total = posting.entries.reduce((sum, e) => sum + e.amount, 0)
  if (total !== 0) throw new Error(`Unbalanced ${posting.kind} posting (sum ${total})`)
  if (posting.entries.some((e) => !Number.isInteger(e.amount) || e.amount === 0)) {
    throw new Error(`Invalid ${posting.kind} entry amount`)
  }

  // ON CONFLICT DO NOTHING matches the partial unique indexes that make
  // reserve/release (per bid) and settle (per auction) idempotent.
  const [row] = await tx
    .insert(ledgerTransactions)
    .values({
      kind: posting.kind,
      auctionId: posting.auctionId ?? null,
      bidId: posting.bidId ?? null,
      memo: posting.memo ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: ledgerTransactions.id })
  if (!row) return null

  try {
    await tx
      .insert(ledgerEntries)
      .values(posting.entries.map((e) => ({ transactionId: row.id, ...e })))
  } catch (error) {
    if (isCheckViolation(error, 'ledger_accounts_balance_nonneg')) {
      throw new InsufficientCreditsError()
    }
    throw error
  }
  return row.id
}

/** Creates the user's `available` and `reserved` accounts (at sign-up). */
export async function openAccounts(tx: Tx, userId: string): Promise<UserAccounts> {
  const rows = await tx
    .insert(ledgerAccounts)
    .values([
      { userId, kind: 'available' },
      { userId, kind: 'reserved' },
    ])
    .returning({ id: ledgerAccounts.id, kind: ledgerAccounts.kind })
  return toUserAccounts(rows, userId)
}

function toUserAccounts(rows: { id: number; kind: string }[], userId: string): UserAccounts {
  const available = rows.find((r) => r.kind === 'available')?.id
  const reserved = rows.find((r) => r.kind === 'reserved')?.id
  if (available === undefined || reserved === undefined) {
    throw new Error(`Ledger accounts missing for user ${userId}`)
  }
  return { available, reserved }
}

export async function userAccounts(ex: Executor, userId: string): Promise<UserAccounts> {
  const rows = await ex
    .select({ id: ledgerAccounts.id, kind: ledgerAccounts.kind })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.userId, userId))
  return toUserAccounts(rows, userId)
}

const systemAccountIds = new Map<string, number>()

async function systemAccount(ex: Executor, kind: 'issuance' | 'revenue'): Promise<number> {
  const cached = systemAccountIds.get(kind)
  if (cached !== undefined) return cached
  const [row] = await ex
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(isNull(ledgerAccounts.userId), eq(ledgerAccounts.kind, kind)))
  if (!row) throw new Error(`System account "${kind}" missing; run the migrations`)
  systemAccountIds.set(kind, row.id)
  return row.id
}

/** For tests that recreate the system accounts. */
export function clearSystemAccountCache() {
  systemAccountIds.clear()
}

/** Gives demo credits to a user (sign-up bonus, top-ups). */
export async function grantCredits(tx: Tx, userId: string, amount: number, memo: string) {
  const [issuance, accounts] = await Promise.all([
    systemAccount(tx, 'issuance'),
    userAccounts(tx, userId),
  ])
  await post(tx, {
    kind: 'grant',
    memo,
    entries: [
      { accountId: issuance, amount: -amount },
      { accountId: accounts.available, amount },
    ],
  })
}

interface BidRef {
  userId: string
  auctionId: string
  bidId: string
  amount: number
}

/**
 * Holds `amount` of the bidder's credits while their bid leads.
 * Throws InsufficientCreditsError; returns false for a repeated bid id.
 */
export async function reserveForBid(tx: Tx, bid: BidRef): Promise<boolean> {
  const accounts = await userAccounts(tx, bid.userId)
  const id = await post(tx, {
    kind: 'reserve',
    auctionId: bid.auctionId,
    bidId: bid.bidId,
    entries: [
      { accountId: accounts.available, amount: -bid.amount },
      { accountId: accounts.reserved, amount: bid.amount },
    ],
  })
  return id !== null
}

/** Returns the credits held by a bid that has been outbid. */
export async function releaseBid(tx: Tx, bid: BidRef): Promise<boolean> {
  const accounts = await userAccounts(tx, bid.userId)
  const id = await post(tx, {
    kind: 'release',
    auctionId: bid.auctionId,
    bidId: bid.bidId,
    entries: [
      { accountId: accounts.reserved, amount: -bid.amount },
      { accountId: accounts.available, amount: bid.amount },
    ],
  })
  return id !== null
}

/** Spends the winner's reserved credits. Runs at most once per auction. */
export async function settleAuction(
  tx: Tx,
  win: { userId: string; auctionId: string; amount: number },
): Promise<boolean> {
  const [revenue, accounts] = await Promise.all([
    systemAccount(tx, 'revenue'),
    userAccounts(tx, win.userId),
  ])
  const id = await post(tx, {
    kind: 'settle',
    auctionId: win.auctionId,
    entries: [
      { accountId: accounts.reserved, amount: -win.amount },
      { accountId: revenue, amount: win.amount },
    ],
  })
  return id !== null
}

export async function getWallet(ex: Executor, userId: string): Promise<Wallet> {
  const rows = await ex
    .select({ kind: ledgerAccounts.kind, balance: ledgerAccounts.balance })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.userId, userId))
  return {
    available: rows.find((r) => r.kind === 'available')?.balance ?? 0,
    reserved: rows.find((r) => r.kind === 'reserved')?.balance ?? 0,
  }
}

/** The user's ledger, newest first, one line per transaction. */
export async function getLedgerHistory(
  ex: Executor,
  userId: string,
  limit = 50,
): Promise<LedgerEntry[]> {
  const rows = await ex
    .select({
      id: ledgerTransactions.id,
      kind: ledgerTransactions.kind,
      auctionId: ledgerTransactions.auctionId,
      auctionTitle: auctions.title,
      createdAt: ledgerTransactions.createdAt,
      available: sql<
        string | null
      >`sum(${ledgerEntries.amount}) filter (where ${ledgerAccounts.kind} = 'available')`,
      reserved: sql<
        string | null
      >`sum(${ledgerEntries.amount}) filter (where ${ledgerAccounts.kind} = 'reserved')`,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .leftJoin(auctions, eq(auctions.id, ledgerTransactions.auctionId))
    .where(eq(ledgerAccounts.userId, userId))
    .groupBy(ledgerTransactions.id, auctions.title)
    .orderBy(desc(ledgerTransactions.id))
    .limit(limit)

  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    available: Number(r.available ?? 0),
    reserved: Number(r.reserved ?? 0),
    auctionId: r.auctionId,
    auctionTitle: r.auctionTitle,
    createdAt: r.createdAt.toISOString(),
  }))
}
