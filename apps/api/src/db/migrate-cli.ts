// `pnpm db:migrate`: apply migrations without starting the server.
import { loadConfig } from '../config'
import { runMigrations } from './migrate'

const config = loadConfig()
await runMigrations(config.databaseUrl)
console.log('migrations applied')
