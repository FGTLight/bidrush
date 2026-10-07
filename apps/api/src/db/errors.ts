/** The fields of a Postgres error that the app reacts to. */
export interface PgError {
  code: string
  constraint_name?: string | undefined
  message: string
}

/** postgres.js errors carry the server's SQLSTATE `code` and a `severity`. */
function isPgError(value: unknown): value is PgError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    'severity' in value
  )
}

/** Finds the Postgres error in a (possibly wrapped) driver/ORM error. */
export function pgError(error: unknown): PgError | null {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth++) {
    if (isPgError(current)) return current
    current = (current as { cause?: unknown }).cause
  }
  return null
}

export const isUniqueViolation = (error: unknown, constraint?: string) => {
  const e = pgError(error)
  return e?.code === '23505' && (!constraint || e.constraint_name === constraint)
}

export const isCheckViolation = (error: unknown, constraint?: string) => {
  const e = pgError(error)
  return e?.code === '23514' && (!constraint || e.constraint_name === constraint)
}
