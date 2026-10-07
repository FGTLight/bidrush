import { useEffect, useReducer } from 'react'

import { markPriceShown, takeInteraction } from '@/lib/interaction'
import { useRealtime, useServerMessages } from '@/realtime/RealtimeProvider'

import { initialRoomState, roomReducer } from './room-state'

/** Live state of one auction room, plus the action of bidding in it. */
export function useAuctionRoom(auctionId: string) {
  const client = useRealtime()
  const [state, dispatch] = useReducer(roomReducer, initialRoomState)

  // Subscribing makes the server send a snapshot now and after every reconnect.
  useEffect(() => client.subscribe(auctionId), [client, auctionId])

  useServerMessages((message) => {
    dispatch({ type: 'server', message, at: Date.now() })
  })

  // Reaction times are measured from the moment a new price is on screen.
  const price = state.auction?.currentPrice
  useEffect(() => {
    if (price !== undefined) markPriceShown()
  }, [price])

  const placeBid = (amount: number, honeypot: string) => {
    const bidId = crypto.randomUUID()
    dispatch({ type: 'bid_sent', bid: { bidId, amount, sentAt: Date.now() } })
    client.sendBid({
      type: 'bid',
      bidId,
      auctionId,
      amount,
      interaction: takeInteraction(honeypot),
    })
  }

  const dismissRejection = () => {
    dispatch({ type: 'dismiss_rejection' })
  }

  return { state, placeBid, dismissRejection }
}
