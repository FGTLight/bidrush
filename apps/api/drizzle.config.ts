import { defineConfig } from 'drizzle-kit'

// `pnpm db:generate` diffs src/db/schema.ts into a new SQL migration.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://bidrush:bidrush@localhost:5432/bidrush',
  },
})
