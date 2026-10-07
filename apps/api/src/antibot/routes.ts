import type { FlaggedUser, RiskEvent } from '@bidrush/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { authOf, requireAdmin } from '../auth/plugin'
import type { Db } from '../db/client'
import { riskEvents, sessions, userRisk, users } from '../db/schema'
import { HttpError } from '../errors'
import type { AntiBotEngine } from './engine'

const idParams = z.object({ id: z.uuid() })

/** Admin review of the anti-bot engine's decisions. */
export async function antibotRoutes(
  app: FastifyInstance,
  { db, antibot }: { db: Db; antibot: AntiBotEngine },
) {
  app.addHook('preHandler', requireAdmin)

  /** Users the engine flagged and an admin hasn't cleared, riskiest first. */
  app.get('/admin/risk/users', async (): Promise<{ users: FlaggedUser[] }> => {
    const rows = await db
      .select({ risk: userRisk, user: users })
      .from(userRisk)
      .innerJoin(users, eq(users.id, userRisk.userId))
      .where(isNull(userRisk.clearedAt))
      .orderBy(desc(userRisk.score), desc(userRisk.lastEventAt))
      .limit(200)
    return {
      users: rows.map(({ risk, user }) => ({
        user: { id: user.id, displayName: user.displayName, email: user.email },
        riskScore: risk.score,
        level: risk.level,
        blocked: user.blockedAt !== null,
        lastEventAt: risk.lastEventAt.toISOString(),
        topReasons: risk.topReasons,
      })),
    }
  })

  /** The timeline behind a flag: every stored decision with its signals. */
  app.get('/admin/risk/users/:id/events', async (req): Promise<{ events: RiskEvent[] }> => {
    const { id } = idParams.parse(req.params)
    const rows = await db
      .select()
      .from(riskEvents)
      .where(eq(riskEvents.userId, id))
      .orderBy(desc(riskEvents.id))
      .limit(100)
    return {
      events: rows.map((e) => ({
        id: String(e.id),
        score: e.score,
        level: e.level,
        signals: e.signals,
        auctionId: e.auctionId,
        createdAt: e.createdAt.toISOString(),
      })),
    }
  })

  app.post('/admin/users/:id/block', async (req, reply) => {
    const { id } = idParams.parse(req.params)
    if (id === authOf(req).userId)
      throw new HttpError(400, 'SELF_BLOCK', "You can't block yourself.")
    const updated = await db
      .update(users)
      .set({ blockedAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id })
    if (updated.length === 0) throw new HttpError(404, 'NOT_FOUND', 'No such user.')
    // Signed-in sessions end now; the user can't bid while blocked anyway.
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)))
    req.log.warn({ userId: id, by: authOf(req).userId }, 'admin blocked user')
    return reply.status(204).send()
  })

  /** False positive: unblock, hide from the flagged list, forget the remembered risk. */
  app.post('/admin/users/:id/clear', async (req, reply) => {
    const { id } = idParams.parse(req.params)
    const updated = await db
      .update(users)
      .set({ blockedAt: null })
      .where(eq(users.id, id))
      .returning({ id: users.id })
    if (updated.length === 0) throw new HttpError(404, 'NOT_FOUND', 'No such user.')
    await db.update(userRisk).set({ clearedAt: new Date() }).where(eq(userRisk.userId, id))
    await antibot.forget(id)
    req.log.info({ userId: id, by: authOf(req).userId }, 'admin cleared user')
    return reply.status(204).send()
  })
}
