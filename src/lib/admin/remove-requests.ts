import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { audit } from '@/lib/util/audit';

export const REMOVED_REASON = 'removed_by_staff';

/**
 * Takes requests off the board: a test that has served its purpose, a duplicate, a thread nobody needs to
 * answer. Nothing is deleted. The request is closed with who removed it, and everything still pending for
 * it stops, so nothing goes out afterwards: queued emails are held back, drafts and price alerts awaiting
 * approval are invalidated, watches and event alerts are cancelled, and queued background work is dropped.
 * A later email from the customer opens a new request, as for any closed one. To erase a person's data,
 * use contact deletion instead.
 */
export async function removeRequests(db: DbOrTx, a: { requestIds: string[]; staffUserId: string; now: Date }): Promise<{ removed: string[] }> {
  if (!a.requestIds.length) return { removed: [] };
  const rows = await db.select({ id: t.requests.id, state: t.requests.state, rev: t.requests.currentRevision }).from(t.requests).where(inArray(t.requests.id, a.requestIds));
  const live = rows.filter((r) => r.state !== 'closed');
  if (!live.length) return { removed: [] };
  const ids = live.map((r) => r.id);
  await db.update(t.requests).set({ state: 'closed', updatedAt: a.now, failureReason: null }).where(inArray(t.requests.id, ids));
  await db.insert(t.requestTransitions).values(live.map((r) => ({ requestId: r.id, fromState: r.state, toState: 'closed', revision: r.rev, actor: a.staffUserId, reason: REMOVED_REASON })));
  await db.update(t.sendIntents).set({ state: 'blocked', lastError: REMOVED_REASON }).where(and(inArray(t.sendIntents.requestId, ids), eq(t.sendIntents.state, 'queued')));
  await db.update(t.recommendations).set({ reviewStatus: 'invalidated' }).where(and(inArray(t.recommendations.requestId, ids), eq(t.recommendations.reviewStatus, 'pending')));
  const watchIds = (await db.select({ id: t.watches.id }).from(t.watches).where(inArray(t.watches.requestId, ids))).map((w) => w.id);
  if (watchIds.length) {
    await db.update(t.watches).set({ state: 'cancelled' }).where(and(inArray(t.watches.id, watchIds), inArray(t.watches.state, ['active', 'paused'])));
    await db.update(t.watchAlerts).set({ approvalState: 'invalidated' }).where(and(inArray(t.watchAlerts.watchId, watchIds), eq(t.watchAlerts.approvalState, 'pending')));
  }
  await db.update(t.eventAlerts).set({ state: 'cancelled' }).where(and(inArray(t.eventAlerts.requestId, ids), eq(t.eventAlerts.state, 'active')));
  await db.update(t.outboxEvents).set({ state: 'dead', lastError: REMOVED_REASON }).where(and(inArray(t.outboxEvents.entityId, ids), eq(t.outboxEvents.state, 'pending')));
  for (const r of live) await audit(db, { actor: a.staffUserId, action: 'request.removed', entityKind: 'request', entityId: r.id, revision: r.rev, diff: { fromState: r.state } });
  return { removed: ids };
}
