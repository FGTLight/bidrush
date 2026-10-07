import { type Auction, QUICK_BID_STEPS } from '@bidrush/shared'
import { Crown, TrendingUp, Trophy } from 'lucide-react'
import { type SubmitEvent, useRef, useState } from 'react'
import { Link } from 'react-router'

import { Button } from '@/components/ui'
import { buttonClass, inputClass } from '@/components/ui/styles'
import { cn } from '@/lib/cn'
import { formatCredits } from '@/lib/format'

import { minimumBid, type MyStatus, quickBidAmount, type RoomState } from './room-state'

const statusCopy: Partial<Record<MyStatus, { text: string; tone: string; Icon: typeof Crown }>> = {
  winning: { text: "You're winning", tone: 'bg-winning/10 text-winning', Icon: Crown },
  outbid: {
    text: "You've been outbid",
    tone: 'bg-outbid/10 text-outbid animate-shake',
    Icon: TrendingUp,
  },
  won: { text: 'You won this auction!', tone: 'bg-winning/10 text-winning', Icon: Trophy },
  lost: {
    text: 'Auction over. Someone else won.',
    tone: 'bg-surface-muted text-ink-muted',
    Icon: TrendingUp,
  },
}

interface BidPanelProps {
  auction: Auction
  room: RoomState
  status: MyStatus
  available: number | null
  onBid: (amount: number, honeypot: string) => void
  onDismiss: () => void
}

export function BidPanel({ auction, room, status, available, onBid, onDismiss }: BidPanelProps) {
  const [custom, setCustom] = useState('')
  // Honeypot: invisible to people, often filled in by naive bots.
  const honeypot = useRef<HTMLInputElement>(null)
  const min = minimumBid(auction)
  const live = auction.status === 'live'
  const copy = statusCopy[status]

  const bid = (amount: number) => {
    onBid(amount, honeypot.current?.value ?? '')
  }

  const submitCustom = (event: SubmitEvent) => {
    event.preventDefault()
    const amount = Number(custom)
    if (Number.isInteger(amount) && amount >= min) {
      bid(amount)
      setCustom('')
    }
  }

  if (status === 'guest') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-ink-muted">Sign up to bid. You get 1,000 demo credits.</p>
        <Link to="/sign-up" className={buttonClass('primary', 'lg', 'w-full')}>
          Join and bid
        </Link>
      </div>
    )
  }

  const canBid = live && status !== 'winning' && status !== 'pending'
  const customAmount = Number(custom)
  const customInvalid = custom !== '' && (!Number.isInteger(customAmount) || customAmount < min)

  return (
    <div className="flex flex-col gap-4">
      {copy && (
        <p
          key={status}
          role="status"
          className={cn(
            'flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold',
            copy.tone,
          )}
        >
          <copy.Icon className="size-4" aria-hidden />
          {copy.text}
        </p>
      )}

      {room.rejection && (
        <div
          role="alert"
          className="flex items-start justify-between gap-2 rounded-xl bg-outbid/10 px-3 py-2 text-sm text-outbid"
        >
          <span>{room.rejection.message}</span>
          <button
            type="button"
            onClick={onDismiss}
            className="font-semibold underline"
            aria-label="Dismiss"
          >
            OK
          </button>
        </div>
      )}

      {live && (
        <>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Quick bids">
            {QUICK_BID_STEPS.map((steps) => {
              const amount = quickBidAmount(auction, steps)
              const tooExpensive = available !== null && amount > available
              return (
                <Button
                  key={steps}
                  variant={steps === 1 ? 'bolt' : 'secondary'}
                  size="xl"
                  className="flex-col gap-0 px-2"
                  disabled={!canBid || tooExpensive}
                  onClick={() => {
                    bid(amount)
                  }}
                  aria-label={`Bid ${formatCredits(amount)}`}
                >
                  <span className="text-xs font-semibold opacity-70">+{steps}×</span>
                  <span className="font-mono text-base tabular-nums">
                    {amount.toLocaleString('en-US')}
                  </span>
                </Button>
              )
            })}
          </div>

          <form onSubmit={submitCustom} className="flex gap-2" noValidate>
            <label htmlFor="custom-bid" className="sr-only">
              Custom bid amount
            </label>
            <input
              id="custom-bid"
              type="number"
              inputMode="numeric"
              min={min}
              step={1}
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value)
              }}
              placeholder={`${min.toLocaleString('en-US')} or more`}
              aria-invalid={customInvalid}
              className={cn(inputClass, 'font-mono')}
            />
            <Button type="submit" disabled={!canBid || custom === '' || customInvalid}>
              Bid
            </Button>
            {/* Honeypot: hidden from people and assistive tech. */}
            <input
              ref={honeypot}
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden
              className="absolute -left-[9999px] size-px opacity-0"
              defaultValue=""
            />
          </form>

          <p className="text-center text-xs text-ink-muted">
            Minimum {formatCredits(min)} · increment {formatCredits(auction.minIncrement)}
            {available !== null && <> · you have {formatCredits(available)}</>}
          </p>
        </>
      )}
    </div>
  )
}
