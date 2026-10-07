/**
 * Vitest global setup: recreates the test database from the migrations.
 * Needs Postgres (and later Redis) from `docker compose up -d postgres redis`,
 * or the service containers in CI.
 */
import postgres from 'postgres'

import { runMigrations } from '../src/db/migrate'
import { TEST_DATABASE_URL } from './env'

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL)
  const dbName = url.pathname.slice(1)
  if (!/^\w+_test$/.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}": test databases must end in _test`)
  }

  // Connect to the server's default database to drop/create the test one.
  const adminUrl = new URL(url)
  adminUrl.pathname = '/postgres'
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined })
  try {
    await admin`select 1`
  } catch (error) {
    throw new Error(
      `Can't reach Postgres at ${url.host}. Start it with: docker compose up -d postgres redis`,
      { cause: error },
    )
  }
  await admin.unsafe(`drop database if exists ${dbName} with (force)`)
  await admin.unsafe(`create database ${dbName}`)
  await admin.end()

  await runMigrations(TEST_DATABASE_URL)
}
