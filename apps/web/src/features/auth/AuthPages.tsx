import { signInBody, signUpBody } from '@bidrush/shared'
import { type SubmitEvent, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'

import { Button, Field } from '@/components/ui'
import { cardClass } from '@/components/ui/styles'
import { ApiRequestError } from '@/lib/api'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

import { useSession, useSignIn, useSignUp } from './session'

type Errors = Record<string, string>

/** Same zod schemas as the API: identical rules, client-side. */
function fieldErrors(result: {
  success: boolean
  error?: { issues: { path: PropertyKey[]; message: string }[] }
}): Errors {
  if (result.success || !result.error) return {}
  return Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]))
}

function useAfterAuth() {
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from
  const target = from?.startsWith('/') && !from.startsWith('//') ? from : '/auctions'
  return () => {
    void navigate(target, { replace: true })
  }
}

function AuthCard({
  title,
  children,
  footer,
}: {
  title: string
  children: React.ReactNode
  footer: React.ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-8">
      <h1 className="text-center text-3xl font-extrabold tracking-tight">{title}</h1>
      <div className={`${cardClass} p-6`}>{children}</div>
      <p className="text-center text-sm text-ink-muted">{footer}</p>
    </div>
  )
}

export function SignInPage() {
  useDocumentTitle('Sign in')
  const { data: session } = useSession()
  const signIn = useSignIn()
  const done = useAfterAuth()
  const [errors, setErrors] = useState<Errors>({})

  if (session) return <Navigate to="/auctions" replace />

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const parsed = signInBody.safeParse({
      email: form.get('email'),
      password: form.get('password'),
    })
    setErrors(fieldErrors(parsed))
    if (parsed.success) signIn.mutate(parsed.data, { onSuccess: done })
  }

  const apiError =
    signIn.error instanceof ApiRequestError
      ? signIn.error.message
      : signIn.error
        ? 'Something went wrong.'
        : null

  return (
    <AuthCard
      title="Welcome back"
      footer={
        <>
          New here?{' '}
          <Link to="/sign-up" className="font-semibold text-brand-600">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Email" name="email" type="email" autoComplete="email" error={errors.email} />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          error={errors.password}
        />
        {apiError && (
          <p role="alert" className="text-sm text-outbid">
            {apiError}
          </p>
        )}
        <Button type="submit" size="lg" loading={signIn.isPending}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  )
}

export function SignUpPage() {
  useDocumentTitle('Create account')
  const { data: session } = useSession()
  const signUp = useSignUp()
  const done = useAfterAuth()
  const [errors, setErrors] = useState<Errors>({})

  if (session) return <Navigate to="/auctions" replace />

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const parsed = signUpBody.safeParse({
      displayName: form.get('displayName'),
      email: form.get('email'),
      password: form.get('password'),
    })
    setErrors(fieldErrors(parsed))
    if (parsed.success) {
      signUp.mutate(parsed.data, {
        onSuccess: done,
        onError: (error) => {
          if (error instanceof ApiRequestError && error.fields) setErrors(error.fields)
        },
      })
    }
  }

  const apiError =
    signUp.error instanceof ApiRequestError
      ? signUp.error.message
      : signUp.error
        ? 'Something went wrong.'
        : null

  return (
    <AuthCard
      title="Get 1,000 demo credits"
      footer={
        <>
          Already bidding?{' '}
          <Link to="/sign-in" className="font-semibold text-brand-600">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label="Display name"
          name="displayName"
          autoComplete="nickname"
          hint="Shown next to your bids."
          error={errors.displayName}
        />
        <Field label="Email" name="email" type="email" autoComplete="email" error={errors.email} />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters."
          error={errors.password}
        />
        {apiError && (
          <p role="alert" className="text-sm text-outbid">
            {apiError}
          </p>
        )}
        <Button type="submit" size="lg" loading={signUp.isPending}>
          Create account
        </Button>
      </form>
    </AuthCard>
  )
}
