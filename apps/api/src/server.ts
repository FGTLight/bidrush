import { buildApp } from './app'
import { loadConfig } from './config'

const config = loadConfig()
const app = await buildApp(config)

// Graceful shutdown: stop accepting work, let in-flight requests finish.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown')
        process.exit(1)
      },
    )
  })
}

await app.listen({ host: config.host, port: config.port })
