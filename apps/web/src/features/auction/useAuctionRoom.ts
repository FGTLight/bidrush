import { auctionDetailResponse } from '@bidrush/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useReducer } from 'react'

import { ApiRequestError, request } from '@/lib/api'

import { markPriceShown, takeInteraction } from '@/lib/interaction'
import { useRealtime, useServerMessages } from '@/realtime/RealtimeProvider'

import { initialRoomState, roomReducer } from './room-state'

/** Live state of one auction room, plus the action of bidding in it. */
export function useAuctionRoom(auctionId: string) {
  const client = useRealtime()
  const [state, dispatch] = useReducer(roomReducer, initialRoomState)

  // Subscribing makes the server send a snapshot now and after every reconnect.
  useEffect(() => client.subscribe(auctionId), [client, auctionId])

  // Faster first paint over HTTP; the WebSocket stream takes over from there.
  useQuery({
    queryKey: ['auction', auctionId],
    queryFn: async ({ signal }) => {
      try {
        const detail = await request(`/auctions/${auctionId}`, {
          schema: auctionDetailResponse,
          signal,
        })
        dispatch({ type: 'initial', snapshot: { type: 'auction_snapshot', ...detail } })
        return detail
      } catch (error) {
        // 404, or 400 for a malformed id: either way there is no such auction.
        if (error instanceof ApiRequestError && (error.status === 404 || error.status === 400)) {
          dispatch({
            type: 'server',
            message: { type: 'error', code: 'AUCTION_NOT_FOUND', message: error.message },
            at: Date.now(),
          })
          return null
        }
        throw error
      }
    },
    staleTime: Infinity,
    retry: false,
  })

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
