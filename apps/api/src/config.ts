import { randomUUID } from 'node:crypto'

import { AUCTION_DEFAULTS } from '@bidrush/shared'
import { z } from 'zod'

import { loadAntiBotConfig } from './antibot/config'

const DEV_JWT_SECRET = 'dev-only-secret-change-me-dev-only-secret'

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Reverse proxies in front of the API (nginx = 1); 0 when exposed directly. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Distinguishes API instances in logs and metrics. */
    INSTANCE_ID: z.string().default(() => `api-${randomUUID().slice(0, 8)}`),

    DATABASE_URL: z.url().default('postgres://bidrush:bidrush@localhost:5432/bidrush'),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    /** When set, GET /metrics requires `Authorization: Bearer <token>`. */
    METRICS_TOKEN: z.string().min(16).optional(),
    /** Keep a rolling schedule of demo auctions so the site always has some live. */
    AUTOPILOT: bool.default(false),
    /** Apply pending migrations at startup (advisory-locked). */
    RUN_MIGRATIONS: bool.default(true),

    JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
    /** Comma-separated origins allowed to call the API with cookies. */
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    /** `Secure` cookies; must be true in production (HTTPS). */
    COOKIE_SECURE: bool.default(false),
    /** `SameSite=None` when the web app is on another site (e.g. Vercel + Railway). */
    COOKIE_CROSS_SITE: bool.default(false),
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(24 * 7),
    /** Demo credits every new account starts with. */
    SIGNUP_CREDITS: z.coerce.number().int().min(0).default(1_000),
    /** Sign-in / sign-up attempts per IP per minute. */
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),

    AUCTION_DURATION_MS: z.coerce.number().int().min(5_000).default(AUCTION_DEFAULTS.durationMs),
    SOFT_CLOSE_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(AUCTION_DEFAULTS.softCloseWindowMs),
    SOFT_CLOSE_EXTENSION_MS: z.coerce.number().int().min(0).default(AUCTION_DEFAULTS.extensionMs),
    SOFT_CLOSE_MAX_EXTENSION_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(AUCTION_DEFAULTS.maxExtensionMs),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return
    if (env.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'Set a real secret' })
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'Must be true' })
    }
  })

export type Config = ReturnType<typeof loadConfig>

/** Reads and validates the environment once, at startup. Fails fast. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment:\n${problems.join('\n')}`)
  }
  const e = parsed.data
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    instanceId: e.INSTANCE_ID,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    runMigrations: e.RUN_MIGRATIONS,
    metricsToken: e.METRICS_TOKEN,
    autopilot: e.AUTOPILOT,
    jwtSecret: e.JWT_SECRET,
    corsOrigins: e.CORS_ORIGINS,
    cookie: { secure: e.COOKIE_SECURE, crossSite: e.COOKIE_CROSS_SITE },
    auth: {
      sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
      signupCredits: e.SIGNUP_CREDITS,
      rateLimitPerMinute: e.AUTH_RATE_LIMIT_PER_MINUTE,
    },
    antibot: loadAntiBotConfig(env),
    auction: {
      durationMs: e.AUCTION_DURATION_MS,
      softCloseWindowMs: e.SOFT_CLOSE_WINDOW_MS,
      extensionMs: e.SOFT_CLOSE_EXTENSION_MS,
      maxExtensionMs: e.SOFT_CLOSE_MAX_EXTENSION_MS,
    },
  }
}
