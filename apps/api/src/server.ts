import { buildApp } from './app'
import { loadConfig } from './config'
import { createDb } from './db/client'
import { runMigrations } from './db/migrate'
import { createRedis } from './redis'

const config = loadConfig()

// Safe with several instances starting at once (advisory lock).
if (config.runMigrations) await runMigrations(config.databaseUrl)

const database = createDb(config.databaseUrl)
const redis = createRedis(config.redisUrl)
await redis.connect()
const app = await buildApp({ config, db: database.db, redis: redis.redis })

// Graceful shutdown: stop accepting work, let in-flight requests finish.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    app
      .close()
      .then(() => Promise.all([database.close(), redis.close()]))
      .then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error({ err }, 'error during shutdown')
          process.exit(1)
        },
      )
  })
}

await app.listen({ host: config.host, port: config.port })
