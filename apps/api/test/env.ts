export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://bidrush:bidrush@localhost:5432/bidrush_test'

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15'
