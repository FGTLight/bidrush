import { ArrowRight, Hourglass, ShieldCheck, Zap } from 'lucide-react'
import { Link } from 'react-router'

import { buttonClass, cardClass } from '@/components/ui/styles'
import { useSession } from '@/features/auth/session'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

const features = [
  {
    Icon: Zap,
    title: 'Decided in milliseconds',
    text: 'Every bid is one atomic database transaction. Two people can never both win the same price.',
  },
  {
    Icon: Hourglass,
    title: 'No sniping',
    text: 'A bid in the last 5 seconds adds 5 more, up to 30 extra seconds. The fastest human wins, not the last click.',
  },
  {
    Icon: ShieldCheck,
    title: 'Bots get caught',
    text: 'Machine-perfect timing, headless browsers and click farms are scored and slowed down, challenged or blocked.',
  },
]

export default function LandingPage() {
  useDocumentTitle(undefined)
  const { data: session } = useSession()
  return (
    <div className="flex flex-col gap-16 py-6">
      <section className="flex flex-col items-start gap-6">
        <p className="rounded-full bg-brand-100 px-3 py-1 font-mono text-xs font-bold uppercase tracking-widest text-brand-700 dark:bg-brand-900/50 dark:text-brand-200">
          60 seconds · one winner
        </p>
        <h1 className="max-w-3xl text-5xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
          Express auctions, <span className="text-brand-600">decided in milliseconds.</span>
        </h1>
        <p className="max-w-xl text-lg text-ink-muted">
          Live one-minute auctions with demo credits. Watch prices jump in real time, beat the
          clock, and see the server keep it fair.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link to="/auctions" className={buttonClass('primary', 'lg')}>
            See live auctions <ArrowRight className="size-4" aria-hidden />
          </Link>
          {!session && (
            <Link to="/sign-up" className={buttonClass('secondary', 'lg')}>
              Get 1,000 free credits
            </Link>
          )}
        </div>
      </section>
      <ul className="grid gap-4 md:grid-cols-3">
        {features.map(({ Icon, title, text }) => (
          <li key={title} className={`${cardClass} flex flex-col gap-3 p-6`}>
            <span className="w-fit rounded-xl bg-brand-100 p-2.5 text-brand-700 dark:bg-brand-900/50 dark:text-brand-200">
              <Icon className="size-5" aria-hidden />
            </span>
            <h2 className="font-bold">{title}</h2>
            <p className="text-sm text-ink-muted">{text}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
