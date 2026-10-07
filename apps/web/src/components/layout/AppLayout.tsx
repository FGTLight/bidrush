import { LogOut, Monitor, Moon, Sun, Wallet, WifiOff, Zap } from 'lucide-react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'

import { buttonClass } from '@/components/ui/styles'
import { useSession, useSignOut, useWalletSync } from '@/features/auth/session'
import { cn } from '@/lib/cn'
import { formatCredits } from '@/lib/format'
import { setTheme, type Theme, useTheme } from '@/lib/theme'
import { useConnectionStatus } from '@/realtime/RealtimeProvider'

const nextTheme: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' }
const themeIcon = { light: Sun, dark: Moon, system: Monitor }

function ThemeToggle() {
  const theme = useTheme()
  const Icon = themeIcon[theme]
  return (
    <button
      type="button"
      onClick={() => {
        setTheme(nextTheme[theme])
      }}
      className={buttonClass('ghost', 'sm', 'w-9 px-0')}
      aria-label={`Theme: ${theme}. Switch to ${nextTheme[theme]}`}
      title={`Theme: ${theme}`}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  )
}

/** Shown while the WebSocket is down; the client reconnects on its own. */
function ConnectionBanner() {
  const status = useConnectionStatus()
  if (status !== 'reconnecting') return null
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-urgent px-4 py-1.5 text-sm font-medium text-zinc-900"
    >
      <WifiOff className="size-4" aria-hidden />
      Connection lost. Reconnecting…
    </div>
  )
}

function Account() {
  const { data: session } = useSession()
  const signOut = useSignOut()
  const navigate = useNavigate()

  if (!session) {
    return (
      <div className="flex items-center gap-2">
        <Link to="/sign-in" className={buttonClass('ghost', 'sm')}>
          Sign in
        </Link>
        <Link to="/sign-up" className={buttonClass('primary', 'sm')}>
          Get 1,000 credits
        </Link>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Link
        to="/wallet"
        className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-sm font-semibold tabular-nums"
        aria-label={`Wallet: ${formatCredits(session.wallet.available)} available`}
      >
        <Wallet className="size-4 text-brand-600" aria-hidden />
        {formatCredits(session.wallet.available)}
      </Link>
      <button
        type="button"
        className={buttonClass('ghost', 'sm', 'w-9 px-0')}
        aria-label={`Sign out ${session.user.displayName}`}
        title="Sign out"
        onClick={() => {
          signOut.mutate(undefined, {
            onSettled: () => {
              void navigate('/')
            },
          })
        }}
      >
        <LogOut className="size-4" aria-hidden />
      </button>
    </div>
  )
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-lg px-3 py-1.5 text-sm font-medium transition',
    isActive
      ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-200'
      : 'text-ink-muted hover:text-ink',
  )

export function AppLayout() {
  const { data: session } = useSession()
  useWalletSync()

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <ConnectionBanner />
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <Link to="/" className="flex items-center gap-1.5 text-lg font-extrabold tracking-tight">
            <span className="rounded-lg bg-brand-600 p-1 text-bolt">
              <Zap className="size-4 fill-current" aria-hidden />
            </span>
            <span>
              Bid<span className="text-brand-600">Rush</span>
            </span>
          </Link>
          <nav aria-label="Main" className="ml-2 hidden items-center gap-1 sm:flex">
            <NavLink to="/auctions" className={navClass}>
              Live auctions
            </NavLink>
            {session && (
              <NavLink to="/me/bids" className={navClass}>
                My bids
              </NavLink>
            )}
            {session?.user.role === 'admin' && (
              <NavLink to="/admin" className={navClass}>
                Admin
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Account />
          </div>
        </div>
        {/* Compact nav for phones. */}
        <nav aria-label="Main (mobile)" className="flex gap-1 overflow-x-auto px-4 pb-2 sm:hidden">
          <NavLink to="/auctions" className={navClass}>
            Live
          </NavLink>
          {session && (
            <>
              <NavLink to="/me/bids" className={navClass}>
                My bids
              </NavLink>
              <NavLink to="/wallet" className={navClass}>
                Wallet
              </NavLink>
            </>
          )}
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-line py-6 text-center text-xs text-ink-muted">
        BidRush · demo credits only, no real money · server-authoritative clock
      </footer>
    </div>
  )
}
