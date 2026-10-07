import {
  type SessionResponse,
  type SignInBody,
  type SignUpBody,
  sessionResponse,
  type Wallet,
} from '@bidrush/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { ApiRequestError, request, setCsrfToken } from '@/lib/api'
import { useRealtime, useServerMessages } from '@/realtime/RealtimeProvider'

export const sessionKey = ['session'] as const

async function fetchSession(): Promise<SessionResponse | null> {
  try {
    const session = await request('/auth/session', { schema: sessionResponse })
    setCsrfToken(session.csrfToken)
    return session
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      setCsrfToken(null)
      return null
    }
    throw error
  }
}

/** The signed-in user and wallet, or null for guests. */
export function useSession() {
  return useQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 60_000 })
}

function useOnSession() {
  const queryClient = useQueryClient()
  const realtime = useRealtime()
  return (session: SessionResponse | null) => {
    setCsrfToken(session?.csrfToken ?? null)
    queryClient.setQueryData(sessionKey, session)
    // Per-user data from the previous session must not leak into the next.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] === 'me' })
    // The WebSocket handshake authenticates with the cookie: reopen it.
    realtime.reconnect()
  }
}

export function useSignIn() {
  const onSession = useOnSession()
  return useMutation({
    mutationFn: (body: SignInBody) =>
      request('/auth/sign-in', { method: 'POST', body, schema: sessionResponse }),
    onSuccess: onSession,
  })
}

export function useSignUp() {
  const onSession = useOnSession()
  return useMutation({
    mutationFn: (body: SignUpBody) =>
      request('/auth/sign-up', { method: 'POST', body, schema: sessionResponse }),
    onSuccess: onSession,
  })
}

export function useSignOut() {
  const onSession = useOnSession()
  return useMutation({
    mutationFn: () => request('/auth/sign-out', { method: 'POST', schema: z.unknown() }),
    onSettled: () => {
      onSession(null)
    },
  })
}

/** Keeps the wallet in the session cache in step with server pushes. */
export function useWalletSync() {
  const queryClient = useQueryClient()
  const update = (wallet: Wallet) => {
    queryClient.setQueryData<SessionResponse | null>(sessionKey, (s) => (s ? { ...s, wallet } : s))
    void queryClient.invalidateQueries({ queryKey: ['me'] })
  }
  useServerMessages((m) => {
    if (m.type === 'wallet') update(m.wallet)
    else if (m.type === 'bid_ack' && m.status === 'accepted') update(m.wallet)
  })
}
