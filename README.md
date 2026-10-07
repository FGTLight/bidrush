# BidRush

Real-time 1-minute express auctions. The server processes bids over WebSockets in milliseconds, settles them with atomic Postgres transactions, and flags automated (bot) bidding.

> Work in progress. The full README (architecture, race-condition proofs, anti-bot engine, load-test results) lands with the final step.

## Monorepo

| Package           | What it is                                                         |
| ----------------- | ------------------------------------------------------------------ |
| `apps/api`        | Fastify + TypeScript API, WebSockets, bid engine, anti-bot engine  |
| `apps/web`        | React + Vite + Tailwind client                                     |
| `packages/shared` | Types and zod schemas for every REST payload and WebSocket message |

## Run locally

```bash
docker compose up --build        # everything → http://localhost:8080
```

Or, for development with hot reload (Postgres and Redis from Docker):

```bash
pnpm install
docker compose up -d postgres redis
cp .env.example .env
pnpm dev                         # web → http://localhost:5173, API → :3000
```

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test
```
