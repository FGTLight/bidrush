import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

export interface DbOptions {
  /** Connections in this instance's pool. */
  max?: number
}

/**
 * One pool per API instance. `postgres` (postgres.js) is used for its
 * pipelining and fast prepared statements on the bid hot path.
 */
export function createDb(url: string, { max = 20 }: DbOptions = {}) {
  const client = postgres(url, {
    max,
    // Fail fast instead of queueing forever when the database is down.
    connect_timeout: 10,
    idle_timeout: 30,
    // Silence NOTICEs (e.g. "relation already exists, skipping").
    onnotice: () => undefined,
  })
  const db = drizzle({ client, schema, casing: 'snake_case' })
  return { db, client, close: () => client.end({ timeout: 5 }) }
}

export type Db = ReturnType<typeof createDb>['db']
/** A transaction handle, as passed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** Anything queries can run on: the pool or an open transaction. */
export type Executor = Db | Tx
