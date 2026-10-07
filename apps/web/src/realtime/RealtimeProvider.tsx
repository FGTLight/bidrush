import type { ServerMessage } from '@bidrush/shared'
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from 'react'

import { API_URL } from '@/lib/api'
import { collectSignals } from '@/lib/signals'

import { type ConnectionStatus, RealtimeClient, realtimeUrl } from './client'

const RealtimeContext = createContext<RealtimeClient | null>(null)

export function RealtimeProvider({
  children,
  client: injected,
}: {
  children: ReactNode
  /** Tests pass a client wired to a fake socket. */
  client?: RealtimeClient
}) {
  const [client] = useState(
    () => injected ?? new RealtimeClient(realtimeUrl(API_URL), { signals: collectSignals }),
  )
  useEffect(() => {
    client.connect()
    return () => {
      client.close()
    }
  }, [client])
  return <RealtimeContext value={client}>{children}</RealtimeContext>
}

export function useRealtime(): RealtimeClient {
  const client = use(RealtimeContext)
  if (!client) throw new Error('useRealtime must be used inside <RealtimeProvider>')
  return client
}

export function useConnectionStatus(): ConnectionStatus {
  const client = useRealtime()
  return useSyncExternalStore(
    (onChange) => client.onStatus(onChange),
    () => client.status,
    () => 'connecting',
  )
}

/** Calls `handler` for every server message (latest handler, stable subscription). */
export function useServerMessages(handler: (message: ServerMessage) => void) {
  const client = useRealtime()
  const onMessage = useEffectEvent(handler)
  useEffect(
    () =>
      client.on((m) => {
        onMessage(m)
      }),
    [client],
  )
}

export interface Clock {
  /** Date.now() of this device. */
  local: number
  /** Best estimate of the server's clock: what countdowns use. */
  server: number
}

/** Re-renders every `intervalMs` with the local and server time. */
export function useClock(intervalMs = 100): Clock {
  const client = useRealtime()
  const read = () => ({ local: Date.now(), server: client.serverNow() })
  const [clock, setClock] = useState(read)
  useEffect(() => {
    const id = setInterval(() => {
      setClock({ local: Date.now(), server: client.serverNow() })
    }, intervalMs)
    return () => {
      clearInterval(id)
    }
  }, [client, intervalMs])
  return clock
}
