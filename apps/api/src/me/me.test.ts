import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { signUp, useTestApp } from '../../test/app'
import { createAuction } from '../../test/db'
import { placeBid } from '../bids/engine'

const { app, db } = await useTestApp()

describe('/me', () => {
  it('returns the wallet with its ledger history', async () => {
    const session = await signUp(app)
    const res = await app.inject({ url: '/me/wallet', headers: { cookie: session.cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      wallet: { available: 1_000, reserved: 0 },
      ledger: [{ kind: 'grant', available: 1_000, reserved: 0 }],
    })
  })

  it('lists my auctions and whether I am winning', async () => {
    const ada = await signUp(app)
    const bob = await signUp(app)
    const first = await createAuction(db, { title: 'Lamp' })
    const second = await createAuction(db, { title: 'Chair' })
    const bid = (auctionId: string, userId: string, amount: number) =>
      placeBid(db, { bidId: randomUUID(), auctionId, userId, amount })
    await bid(first.id, ada.body.user.id, 100)
    await bid(second.id, ada.body.user.id, 100)
    await bid(second.id, bob.body.user.id, 110)

    const res = await app.inject({ url: '/me/bids', headers: { cookie: ada.cookie } })
    const items = res.json<{
      items: { auction: { title: string }; winning: boolean; myHighestBid: number }[]
    }>().items
    expect(items.map((i) => [i.auction.title, i.winning, i.myHighestBid])).toEqual([
      ['Chair', false, 100],
      ['Lamp', true, 100],
    ])
  })

  it('is for signed-in users only', async () => {
    expect((await app.inject({ url: '/me/bids' })).statusCode).toBe(401)
  })
})
