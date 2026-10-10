import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import { outboxEvents } from '@/lib/db/schema';

/**
 * Whether the outbox dispatcher is running (audit 2026-10-10, gap 26): the only scheduler is a cron whose keys live in
 * a dashboard, and /api/health checked the database alone, so a stalled dispatcher looked healthy while customers'
 * emails waited. `outboxLagSeconds` is how long the oldest row the next pass would pick up has been due (0 when none
 * is), counted from when it became due rather than when it was written, so a row sitting in retry backoff is not
 * scheduler lag. `lastDispatchAt` is the newest row any dispatcher finished.
 */
export type SchedulerLiveness = { outboxLagSeconds: number; lastDispatchAt: string | null };

export async function schedulerLiveness(db: DbOrTx, now: Date): Promise<SchedulerLiveness> {
  // ISO string + explicit cast: a bare Date in a raw template throws on postgres.js (it only works on PGlite).
  const nowIso = now.toISOString();
  const [due] = await db
    .select({ at: sql<Date | string | null>`min(${outboxEvents.nextAttemptAt})` })
    .from(outboxEvents)
    .where(sql`(${outboxEvents.state} = 'pending' or (${outboxEvents.state} = 'leased' and ${outboxEvents.leaseUntil} < ${nowIso}::timestamptz)) and ${outboxEvents.nextAttemptAt} <= ${nowIso}::timestamptz`);
  const [done] = await db
    .select({ at: outboxEvents.dispatchedAt })
    .from(outboxEvents)
    .where(sql`${outboxEvents.state} = 'dispatched' and ${outboxEvents.dispatchedAt} is not null`)
    .orderBy(sql`${outboxEvents.dispatchedAt} desc`)
    .limit(1);
  const dueAt = due?.at ? new Date(due.at) : null;
  return {
    outboxLagSeconds: dueAt ? Math.max(0, Math.round((now.getTime() - dueAt.getTime()) / 1000)) : 0,
    lastDispatchAt: done?.at ? new Date(done.at).toISOString() : null,
  };
}

/**
 * The deployed commit, short (gap 26): Render sets RENDER_GIT_COMMIT, other builds GIT_COMMIT. For staff pages only;
 * the public health endpoint does not name the build.
 */
export function deployedCommit(e: Record<string, string | undefined> = process.env): string | null {
  const sha = (e.RENDER_GIT_COMMIT ?? e.GIT_COMMIT ?? '').trim();
  return sha ? sha.slice(0, 7) : null;
}
