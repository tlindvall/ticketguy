import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import type { Env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { audit } from '@/lib/util/audit';
import { MarketTracker } from '@/lib/market/tracker';
import { allows, operationsForClaims } from '@/lib/domain/service-depth';
import { policyForEvent } from './service-policy';

/**
 * Rollout reconciliation for the service-depth policy (DECISION_LOG #61): what enforcing would change in work
 * that already exists — tracked events, active watches, their pending alerts, and drafts waiting for review.
 * Dry run by default: every action is listed with its reason and nothing is touched. With `apply`, newly
 * ineligible work is paused (never deleted, so history within its licence stays) and unsent alerts and drafts
 * are invalidated through the same generation and invalidation paths as a cancellation.
 *
 * Judged as enforce would judge it, whatever SERVICE_POLICY_MODE is set to, so the dry run can be read first.
 */
export type ReconcileAction = {
  kind: 'tracked_event' | 'watch' | 'watch_alert' | 'recommendation';
  id: string;
  action: 'keep' | 'pause' | 'invalidate';
  reason: string;
};

export async function reconcileServiceDepth(db: DbOrTx, env: Env, opts: { apply: boolean; now: Date }): Promise<{ applied: boolean; actions: ReconcileAction[] }> {
  const e: Env = { ...env, SERVICE_POLICY_MODE: 'enforce' };
  const actions: ReconcileAction[] = [];
  const tracker = new MarketTracker({ db, env: e, now: () => opts.now });

  // Tracked events: kept while some reason still holds (a named cohort, or an open request whose depth tracks).
  const tracked = await db.select().from(t.trackedEvents).where(inArray(t.trackedEvents.state, ['pending_match', 'requested', 'active']));
  for (const tr of tracked) {
    const valid = await tracker.validReasons(tr);
    actions.push(valid.length ? { kind: 'tracked_event', id: tr.id, action: 'keep', reason: `valid:${valid.join(',')}` } : { kind: 'tracked_event', id: tr.id, action: 'pause', reason: 'policy:no_valid_reason' });
  }

  // Active watches: kept only where the depth watches and a monitoring source covers the event today.
  const watches = await db.select().from(t.watches).where(eq(t.watches.state, 'active'));
  for (const w of watches) {
    const snap = await policyForEvent(db, e, w.eventId, opts.now);
    const reason = !snap ? 'event_missing' : !allows(snap.decision, 'price_watch') ? `policy:${snap.decision.depth}` : snap.capabilities.price_watch.state !== 'available' ? `capability:${snap.capabilities.price_watch.reasons[0] ?? 'monitoring_unavailable'}` : null;
    actions.push({ kind: 'watch', id: w.id, action: reason ? 'pause' : 'keep', reason: reason ?? 'eligible' });
    if (reason) {
      const pending = await db.select({ id: t.watchAlerts.id }).from(t.watchAlerts).where(and(eq(t.watchAlerts.watchId, w.id), eq(t.watchAlerts.approvalState, 'pending')));
      for (const a of pending) actions.push({ kind: 'watch_alert', id: a.id, action: 'invalidate', reason });
    }
  }

  // Drafts waiting for review whose claims rely on work the event's depth no longer allows.
  const drafts = await db.select({ rec: t.recommendations, req: t.requests, run: t.adviceRuns }).from(t.recommendations).innerJoin(t.requests, eq(t.requests.id, t.recommendations.requestId)).leftJoin(t.adviceRuns, eq(t.adviceRuns.id, t.recommendations.adviceRunId)).where(eq(t.recommendations.reviewStatus, 'pending'));
  for (const { rec, req, run } of drafts) {
    if (!req.eventId) continue;
    const snap = await policyForEvent(db, e, req.eventId, opts.now);
    const kinds = ((run?.packet as { claimRecords?: Array<{ kind: string }> } | null)?.claimRecords ?? []).map((c) => c.kind);
    const lost = snap ? operationsForClaims(kinds).filter((op) => !allows(snap.decision, op)) : [];
    actions.push(lost.length ? { kind: 'recommendation', id: rec.id, action: 'invalidate', reason: `policy_changed:${lost.join(',')}` } : { kind: 'recommendation', id: rec.id, action: 'keep', reason: 'claims_allowed' });
  }

  if (opts.apply) {
    for (const a of actions) {
      if (a.action === 'keep') continue;
      if (a.kind === 'tracked_event') await db.update(t.trackedEvents).set({ state: 'paused', pauseReason: a.reason }).where(eq(t.trackedEvents.id, a.id));
      if (a.kind === 'watch') {
        const [w] = await db.select().from(t.watches).where(eq(t.watches.id, a.id));
        if (w) await db.update(t.watches).set({ state: 'paused', pauseReason: a.reason, generation: w.generation + 1 }).where(eq(t.watches.id, a.id));
      }
      if (a.kind === 'watch_alert') {
        await db.update(t.watchAlerts).set({ approvalState: 'invalidated' }).where(eq(t.watchAlerts.id, a.id));
        const [al] = await db.select({ sendIntentId: t.watchAlerts.sendIntentId }).from(t.watchAlerts).where(eq(t.watchAlerts.id, a.id));
        if (al?.sendIntentId) await db.update(t.sendIntents).set({ state: 'blocked', lastError: 'policy_changed' }).where(and(eq(t.sendIntents.id, al.sendIntentId), eq(t.sendIntents.state, 'queued')));
      }
      if (a.kind === 'recommendation') await db.update(t.recommendations).set({ reviewStatus: 'invalidated', reviewNote: a.reason }).where(eq(t.recommendations.id, a.id));
      await audit(db, { actor: 'system', action: `service_policy.reconcile_${a.action}`, entityKind: a.kind, entityId: a.id, diff: { reason: a.reason } });
    }
  }
  return { applied: opts.apply, actions };
}
