import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema'
import {
  createAuction,
  createUser,
  expectLedgerConsistent,
  pgErrorOf,
  resetDb,
  useTestDb,
} from '../../test/db'
import {
  getLedgerHistory,
  getWallet,
  grantCredits,
  InsufficientCreditsError,
  releaseBid,
  reserveForBid,
  settleAuction,
  userAccounts,
} from './ledger'

const { db } = useTestDb()

beforeEach(() => resetDb(db))

describe('credits ledger', () => {
  it('grants credits from the issuance account', async () => {
    const user = await createUser(db, { credits: 1_000 })
    expect(await getWallet(db, user.id)).toEqual({ available: 1_000, reserved: 0 })
    await expectLedgerConsistent(db)
  })

  it('reserves, releases and settles bids', async () => {
    const auction = await createAuction(db)
    const ada = await createUser(db, { credits: 1_000 })
    const bob = await createUser(db, { credits: 1_000 })
    const adaBid = { userId: ada.id, auctionId: auction.id, bidId: randomUUID(), amount: 150 }
    const bobBid = { userId: bob.id, auctionId: auction.id, bidId: randomUUID(), amount: 200 }

    await db.transaction((tx) => reserveForBid(tx, adaBid))
    expect(await getWallet(db, ada.id)).toEqual({ available: 850, reserved: 150 })

    // Bob outbids Ada: his credits are held, hers are returned.
    await db.transaction(async (tx) => {
      await reserveForBid(tx, bobBid)
      await releaseBid(tx, adaBid)
    })
    expect(await getWallet(db, ada.id)).toEqual({ available: 1_000, reserved: 0 })
    expect(await getWallet(db, bob.id)).toEqual({ available: 800, reserved: 200 })

    await db.transaction((tx) =>
      settleAuction(tx, { userId: bob.id, auctionId: auction.id, amount: 200 }),
    )
    expect(await getWallet(db, bob.id)).toEqual({ available: 800, reserved: 0 })
    await expectLedgerConsistent(db)
  })

  it('refuses to overdraw and leaves no trace', async () => {
    const auction = await createAuction(db)
    const user = await createUser(db, { credits: 100 })
    const bid = { userId: user.id, auctionId: auction.id, bidId: randomUUID(), amount: 101 }

    await expect(db.transaction((tx) => reserveForBid(tx, bid))).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    )
    expect(await getWallet(db, user.id)).toEqual({ available: 100, reserved: 0 })
    const reserves = await db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.kind, 'reserve'))
    expect(reserves).toHaveLength(0)
    await expectLedgerConsistent(db)
  })

  it('reserves a bid at most once, however often it is retried', async () => {
    const auction = await createAuction(db)
    const user = await createUser(db, { credits: 1_000 })
    const bid = { userId: user.id, auctionId: auction.id, bidId: randomUUID(), amount: 300 }

    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.transaction((tx) => reserveForBid(tx, bid))),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await getWallet(db, user.id)).toEqual({ available: 700, reserved: 300 })
    await expectLedgerConsistent(db)
  })

  it('settles an auction at most once', async () => {
    const auction = await createAuction(db)
    const user = await createUser(db, { credits: 1_000 })
    const bid = { userId: user.id, auctionId: auction.id, bidId: randomUUID(), amount: 300 }
    await db.transaction((tx) => reserveForBid(tx, bid))

    const win = { userId: user.id, auctionId: auction.id, amount: 300 }
    const results = await Promise.all(
      Array.from({ length: 5 }, () => db.transaction((tx) => settleAuction(tx, win))),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await getWallet(db, user.id)).toEqual({ available: 700, reserved: 0 })
    await expectLedgerConsistent(db)
  })

  it('never loses a concurrent reservation by the same user', async () => {
    const auction = await createAuction(db)
    const user = await createUser(db, { credits: 1_000 })
    // 30 parallel reservations of 50 against 1,000 credits: exactly 20 fit.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        db.transaction((tx) =>
          reserveForBid(tx, {
            userId: user.id,
            auctionId: auction.id,
            bidId: randomUUID(),
            amount: 50,
          }),
        ),
      ),
    )
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(20)
    expect(
      outcomes.filter(
        (o) => o.status === 'rejected' && o.reason instanceof InsufficientCreditsError,
      ),
    ).toHaveLength(10)
    expect(await getWallet(db, user.id)).toEqual({ available: 0, reserved: 1_000 })
    await expectLedgerConsistent(db)
  })

  it('lists the history from the user’s point of view', async () => {
    const auction = await createAuction(db, { title: 'Retro console' })
    const user = await createUser(db, { credits: 500 })
    const bid = { userId: user.id, auctionId: auction.id, bidId: randomUUID(), amount: 120 }
    await db.transaction((tx) => reserveForBid(tx, bid))
    await db.transaction((tx) =>
      settleAuction(tx, { userId: user.id, auctionId: auction.id, amount: 120 }),
    )

    const history = await getLedgerHistory(db, user.id)
    expect(
      history.map(({ kind, available, reserved, auctionTitle }) => ({
        kind,
        available,
        reserved,
        auctionTitle,
      })),
    ).toEqual([
      { kind: 'settle', available: 0, reserved: -120, auctionTitle: 'Retro console' },
      { kind: 'reserve', available: -120, reserved: 120, auctionTitle: 'Retro console' },
      { kind: 'grant', available: 500, reserved: 0, auctionTitle: null },
    ])
  })
})

describe('invariants enforced by Postgres', () => {
  it('rejects an unbalanced transaction at commit', async () => {
    const user = await createUser(db)
    const { available } = await userAccounts(db, user.id)
    await expect(
      db.transaction(async (tx) => {
        const [t] = await tx
          .insert(ledgerTransactions)
          .values({ kind: 'grant' })
          .returning({ id: ledgerTransactions.id })
        // Credits out of thin air: no matching debit.
        await tx
          .insert(ledgerEntries)
          .values({ transactionId: t!.id, accountId: available, amount: 1_000 })
      }),
    ).rejects.toThrow(/unbalanced/)
    expect(await getWallet(db, user.id)).toEqual({ available: 0, reserved: 0 })
  })

  it('forbids editing balances directly', async () => {
    const user = await createUser(db, { credits: 10 })
    const error = await pgErrorOf(
      db
        .update(ledgerAccounts)
        .set({ balance: 1_000_000 })
        .where(eq(ledgerAccounts.userId, user.id)),
    )
    expect(error.message).toMatch(/only through ledger_entries/)
    expect(await getWallet(db, user.id)).toEqual({ available: 10, reserved: 0 })
  })

  it('keeps the ledger append-only', async () => {
    await createUser(db, { credits: 10 })
    const update = await pgErrorOf(db.execute(sql`update ledger_entries set amount = amount * 2`))
    expect(update.message).toMatch(/ledger_entries is append-only/)
    const remove = await pgErrorOf(db.execute(sql`delete from ledger_transactions`))
    expect(remove.message).toMatch(/ledger_transactions is append-only/)
  })

  it('refuses direct overdrafts too, not just through the module', async () => {
    const user = await createUser(db, { credits: 10 })
    await expect(
      db.transaction((tx) => grantCredits(tx, user.id, -50, 'claw back too much')),
    ).rejects.toBeInstanceOf(InsufficientCreditsError)
  })
})
