import { cn } from '@/lib/cn'

const variants = {
  primary:
    'bg-brand-600 text-white shadow-sm shadow-brand-600/30 hover:bg-brand-700 disabled:bg-brand-600/50 disabled:shadow-none',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-muted disabled:opacity-50',
  ghost: 'text-ink-muted hover:bg-surface-muted hover:text-ink',
  danger: 'bg-outbid text-white hover:bg-outbid/90 disabled:opacity-50',
  bolt: 'bg-bolt text-zinc-900 shadow-sm hover:brightness-95 disabled:opacity-50',
}

const sizes = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
  xl: 'h-14 px-6 text-lg',
}

export type ButtonVariant = keyof typeof variants
export type ButtonSize = keyof typeof sizes

/** Classes for buttons and button-styled links. `extra` is for layout only. */
export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  extra?: string,
) {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition',
    'active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100',
    variants[variant],
    sizes[size],
    extra,
  )
}

export const inputClass = cn(
  'w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-ink',
  'placeholder:text-ink-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30',
  'aria-invalid:border-outbid aria-invalid:ring-outbid/20',
)

export const cardClass = 'rounded-2xl border border-line bg-surface shadow-sm'
