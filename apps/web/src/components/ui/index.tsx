import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from 'react'

import { cn } from '@/lib/cn'

import { type ButtonSize, buttonClass, type ButtonVariant, inputClass } from './styles'

export function Button({
  variant,
  size,
  loading = false,
  className,
  disabled,
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
      {...props}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className ?? 'size-5')} viewBox="0 0 24 24" aria-hidden>
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        opacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Field({
  label,
  error,
  hint,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId()
  const messageId = `${id}-message`
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error || hint ? messageId : undefined}
        className={inputClass}
        {...props}
      />
      {error ? (
        <p id={messageId} role="alert" className="text-xs text-outbid">
          {error}
        </p>
      ) : (
        hint && (
          <p id={messageId} className="text-xs text-ink-muted">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

const tones = {
  live: 'bg-outbid/10 text-outbid',
  scheduled: 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200',
  ended: 'bg-surface-muted text-ink-muted',
  winning: 'bg-winning/10 text-winning',
  neutral: 'bg-surface-muted text-ink-muted',
}

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: keyof typeof tones
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
        tones[tone],
        className,
      )}
    >
      {tone === 'live' && (
        <span className="size-1.5 animate-pulse rounded-full bg-outbid" aria-hidden />
      )}
      {children}
    </span>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-xl bg-surface-muted', className)} />
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line px-6 py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="max-w-sm text-sm text-ink-muted">{description}</p>}
      {action}
    </div>
  )
}
