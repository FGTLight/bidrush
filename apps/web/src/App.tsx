import { lazy, Suspense } from 'react'
import { Link, Route, Routes } from 'react-router'

import { AppLayout } from '@/components/layout/AppLayout'
import { EmptyState, Skeleton } from '@/components/ui'
import { buttonClass } from '@/components/ui/styles'
import { SignInPage, SignUpPage } from '@/features/auth/AuthPages'
import LandingPage from '@/pages/LandingPage'

const AuctionsPage = lazy(() => import('@/features/lobby/AuctionsPage'))
const AuctionRoomPage = lazy(() => import('@/features/auction/AuctionRoomPage'))
const MyBidsPage = lazy(() =>
  import('@/features/me/MePages').then((m) => ({ default: m.MyBidsPage })),
)
const AdminPage = lazy(() => import('@/features/admin/AdminPage'))
const WalletPage = lazy(() =>
  import('@/features/me/MePages').then((m) => ({ default: m.WalletPage })),
)

function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      action={
        <Link to="/auctions" className={buttonClass()}>
          See live auctions
        </Link>
      }
    />
  )
}

export function App() {
  return (
    <Suspense fallback={<Skeleton className="m-8 h-64" />}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<LandingPage />} />
          <Route path="auctions" element={<AuctionsPage />} />
          <Route path="auctions/:id" element={<AuctionRoomPage />} />
          <Route path="sign-in" element={<SignInPage />} />
          <Route path="sign-up" element={<SignUpPage />} />
          <Route path="me/bids" element={<MyBidsPage />} />
          <Route path="wallet" element={<WalletPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
