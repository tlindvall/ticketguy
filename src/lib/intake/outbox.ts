import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbOrTx } from '@/lib/db';
import { outboxEvents } from '@/lib/db/schema';

/**
 * Transactional outbox (ENGINEERING_SPEC §4). Rows are written in the same transaction as the business
 * fact; a dispatcher leases due rows with FOR UPDATE SKIP LOCKED and publishes them. Duplicate event keys
 * are ignored (A16). Payloads carry IDs/revisions only.
 */
export type OutboxEventType =
  | 'email.received'
  | 'request.interpret'
  | 'research.requested'
  | 'recommendation.review_ready'
  | 'email.send_requested'
  | 'watch.due'
  | 'watch.evaluate'
  | 'contact.delete_requested'
  | 'retention.due'
  | 'advice.prepare';

export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_LEASE_SECONDS = 60;

export async function enqueueOutbox(tx: DbOrTx, args: { eventType: OutboxEventType; eventKey: string; entityId: string; revision?: number; payload: Record<string, unknown>; now?: Date }): Promise<{ inserted: boolean; id: string | null }> {
  const rows = await tx
    .insert(outboxEvents)
    .values({ eventType: args.eventType, eventKey: args.eventKey, entityId: args.entityId, revision: args.revision ?? 1, payload: args.payload, nextAttemptAt: args.now ?? new Date(), createdAt: args.now ?? new Date() })
    .onConflictDoNothing({ target: outboxEvents.eventKey })
    .returning({ id: outboxEvents.id });
  return { inserted: rows.length > 0, id: rows[0]?.id ?? null };
}

export type LeasedEvent = { id: string; eventType: string; eventKey: string; entityId: string; revision: number; payload: Record<string, unknown>; attempts: number; leaseToken: string };

/** Leases up to `limit` due rows atomically. Safe to run concurrently from several workers on PostgreSQL. */
export async function leaseDueOutbox(db: DbOrTx, args: { limit: number; now: Date; leaseSeconds?: number }): Promise<LeasedEvent[]> {
  const token = randomUUID();
  const leaseUntil = new Date(args.now.getTime() + (args.leaseSeconds ?? OUTBOX_LEASE_SECONDS) * 1000);
  // Raw statements pass timestamps as ISO strings with explicit casts: postgres.js and PGlite both accept them,
  // whereas Date objects in untyped raw parameters are serialized inconsistently across the two drivers.
  const nowIso = args.now.toISOString();
  const leaseIso = leaseUntil.toISOString();
  const rows = await db.execute<{ id: string; event_type: string; event_key: string; entity_id: string; revision: number; payload: Record<string, unknown>; attempts: number }>(sql`
    with due as (
      select id from ${outboxEvents}
      where (state = 'pending' or (state = 'leased' and lease_until < ${nowIso}::timestamptz))
        and next_attempt_at <= ${nowIso}::timestamptz
      order by next_attempt_at asc
      limit ${args.limit}::int
      for update skip locked
    )
    update ${outboxEvents} o
      set state = 'leased', lease_token = ${token}, lease_until = ${leaseIso}::timestamptz, attempts = o.attempts + 1
    from due where o.id = due.id
    returning o.id, o.event_type, o.event_key, o.entity_id, o.revision, o.payload, o.attempts
  `);
  const list = (Array.isArray(rows) ? rows : (rows as unknown as { rows: unknown[] }).rows) as Array<{ id: string; event_type: string; event_key: string; entity_id: string; revision: number; payload: Record<string, unknown>; attempts: number }>;
  return list.map((r) => ({ id: r.id, eventType: r.event_type, eventKey: r.event_key, entityId: r.entity_id, revision: r.revision, payload: r.payload, attempts: r.attempts, leaseToken: token }));
}

export function backoffSeconds(attempt: number): number {
  const base = Math.min(3600, 2 ** Math.min(attempt, 12) * 5);
  const jitter = Math.floor(Math.random() * Math.min(30, base * 0.2));
  return base + jitter;
}

export async function markDispatched(db: DbOrTx, id: string, leaseToken: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(outboxEvents)
    .set({ state: 'dispatched', dispatchedAt: now, leaseToken: null, leaseUntil: null })
    .where(and(eq(outboxEvents.id, id), eq(outboxEvents.leaseToken, leaseToken)))
    .returning({ id: outboxEvents.id });
  return rows.length > 0;
}

export async function markFailed(db: DbOrTx, ev: LeasedEvent, error: string, now: Date): Promise<'retry' | 'dead'> {
  const dead = ev.attempts >= OUTBOX_MAX_ATTEMPTS;
  await db
    .update(outboxEvents)
    .set({
      state: dead ? 'dead' : 'pending',
      lastError: error.slice(0, 2000),
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: new Date(now.getTime() + backoffSeconds(ev.attempts) * 1000),
    })
    .where(and(eq(outboxEvents.id, ev.id), eq(outboxEvents.leaseToken, ev.leaseToken)));
  return dead ? 'dead' : 'retry';
}

/** Staff replay for dead-lettered rows preserves the original event key (idempotency). */
export async function replayDead(db: DbOrTx, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(outboxEvents)
    .set({ state: 'pending', attempts: 0, nextAttemptAt: now, lastError: null })
    .where(and(eq(outboxEvents.id, id), eq(outboxEvents.state, 'dead')))
    .returning({ id: outboxEvents.id });
  return rows.length > 0;
}

export type OutboxLag = { pending: number; due: number; dead: number; oldestPendingSeconds: number | null };

/**
 * Outbox health. `due` is what the next dispatcher pass will pick up; `pending` also counts rows sitting in
 * retry backoff. Reporting only `due` made a repeatedly failing pipeline read as an empty queue, because a row
 * that just failed always has next_attempt_at in the future.
 */
export async function outboxLag(db: DbOrTx, now: Date): Promise<OutboxLag> {
  // ISO string + explicit cast: a bare Date in a raw template throws on postgres.js (it only works on PGlite).
  const nowIso = now.toISOString();
  const [agg] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${outboxEvents.state} = 'pending')::int`,
      due: sql<number>`count(*) filter (where ${outboxEvents.state} = 'pending' and ${outboxEvents.nextAttemptAt} <= ${nowIso}::timestamptz)::int`,
      dead: sql<number>`count(*) filter (where ${outboxEvents.state} = 'dead')::int`,
      oldest: sql<Date | null>`min(created_at) filter (where ${outboxEvents.state} = 'pending')`,
    })
    .from(outboxEvents);
  const oldest = agg?.oldest ? new Date(agg.oldest) : null;
  return {
    pending: agg?.pending ?? 0,
    due: agg?.due ?? 0,
    dead: agg?.dead ?? 0,
    oldestPendingSeconds: oldest ? Math.round((now.getTime() - oldest.getTime()) / 1000) : null,
  };
}

/** Rows that have failed at least once and are still being retried. Invisible in the plain lag counters. */
export async function retryingOutbox(db: DbOrTx, limit = 20): Promise<Array<{ id: string; eventType: string; eventKey: string; attempts: number; lastError: string | null; nextAttemptAt: Date }>> {
  return db
    .select({ id: outboxEvents.id, eventType: outboxEvents.eventType, eventKey: outboxEvents.eventKey, attempts: outboxEvents.attempts, lastError: outboxEvents.lastError, nextAttemptAt: outboxEvents.nextAttemptAt })
    .from(outboxEvents)
    .where(and(inArray(outboxEvents.state, ['pending', 'leased']), gt(outboxEvents.attempts, 0)))
    .orderBy(desc(outboxEvents.attempts))
    .limit(limit);
}
