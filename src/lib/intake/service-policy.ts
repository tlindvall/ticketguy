import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import type { Env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { SEATDATA_DATASET_ID, SEATDATA_PROVIDER } from '@/lib/market/series';
import { audit } from '@/lib/util/audit';
import {
  OPERATIONS, allows, evaluateOperationCapability, eventFormat, resolveServicePolicy,
  type AdapterFacts, type EventCapabilityDecision, type Operation, type OutsideIntent, type PolicyMode, type ServicePolicyDecision,
} from '@/lib/domain/service-depth';

/**
 * The service-depth policy read against the database: an event's decision and, for each operation, whether it
 * can run now. Every worker that spends money or makes a promise asks here at the moment it runs (research,
 * market tracking, watch creation, evaluation, approval and dispatch); a stored snapshot is an audit record, not
 * a permission.
 */

export type PolicySnapshot = {
  mode: PolicyMode;
  decision: ServicePolicyDecision;
  /** Business policy AND rights/coverage: what enforce allows. */
  capabilities: Record<Operation, EventCapabilityDecision>;
  /** Rights, configuration and coverage alone, whatever the depth: the safety checks every mode keeps. */
  rights: Record<Operation, EventCapabilityDecision>;
};

/** The capability a worker acts on: policy and rights under enforce, rights alone otherwise. */
export function capability(snap: PolicySnapshot, op: Operation): EventCapabilityDecision {
  return snap.mode === 'enforce' ? snap.capabilities[op] : snap.rights[op];
}

export const policyMode = (env: Pick<Env, 'SERVICE_POLICY_MODE'>): PolicyMode => env.SERVICE_POLICY_MODE;
export const enforcing = (env: Pick<Env, 'SERVICE_POLICY_MODE'>): boolean => env.SERVICE_POLICY_MODE === 'enforce';

/** What each implementation can do when its config row names no capabilities (adapters.ts). */
const IMPLEMENTATION_CAPABILITIES: Record<string, string[]> = { manual: ['quote_search', 'quote_revalidation'], fixture: ['event_lookup', 'quote_search', 'quote_revalidation', 'monitoring'], ticketmaster_discovery: ['discovery', 'event_lookup'] };

export async function adapterFacts(db: DbOrTx): Promise<AdapterFacts[]> {
  const rows = await db.select().from(t.adapterConfigs);
  return rows.map((c) => ({ sourceId: c.sourceId, implementation: c.implementation, enabled: c.enabled, capabilities: c.capabilities.length ? c.capabilities : IMPLEMENTATION_CAPABILITIES[c.implementation] ?? [], monitoringAllowed: c.monitoringAllowed, accessApproved: !!c.accessApprovalEvidence }));
}

/**
 * The sources that know this event: one with a provider id mapped to it, or, in the synthetic fixture world, a
 * fixture adapter for a fixture event. An adapter that's enabled but has never seen the event doesn't cover it.
 */
export async function coveredSourceIds(db: DbOrTx, event: { id: string; isFixture: boolean }, adapters: AdapterFacts[]): Promise<string[]> {
  const mapped = (await db.select({ sourceId: t.eventSourceMappings.sourceId }).from(t.eventSourceMappings).where(eq(t.eventSourceMappings.eventId, event.id))).map((m) => m.sourceId);
  const fixtures = event.isFixture ? adapters.filter((a) => a.implementation === 'fixture').map((a) => a.sourceId) : [];
  return [...new Set([...mapped, ...fixtures])];
}

async function licenceFacts(db: DbOrTx, now: Date): Promise<{ tracking: boolean; benchmark: boolean; advice: boolean; alerts: boolean }> {
  const rows = await db.select().from(t.marketDatasets);
  const live = (r: typeof t.marketDatasets.$inferSelect) => r.status === 'approved' && (!r.rawRetentionUntil || r.rawRetentionUntil > now);
  const seat = rows.find((r) => r.id === SEATDATA_DATASET_ID);
  const seatUses = seat && live(seat) ? seat.approvedUses : [];
  // A historical benchmark can come from any approved dataset (the synthetic one in the fixture world).
  const benchmark = rows.some((r) => live(r) && r.approvedUses.includes('benchmark'));
  return { tracking: seatUses.includes('tracking'), benchmark, advice: seatUses.includes('advice'), alerts: seatUses.includes('alerts') };
}

type EventRows = { e: typeof t.events.$inferSelect; v: typeof t.venues.$inferSelect; ent: typeof t.entities.$inferSelect | null };

export async function loadEventRows(db: DbOrTx, eventId: string): Promise<EventRows | null> {
  const [row] = await db.select({ e: t.events, v: t.venues, ent: t.entities }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).leftJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId)).where(eq(t.events.id, eventId));
  return row ?? null;
}

export function decisionForEvent(env: Pick<Env, 'blockedCategories' | 'serviceDepthOverrides'>, row: EventRows, now: Date, outsideIntent: OutsideIntent | null = null): ServicePolicyDecision {
  return resolveServicePolicy({
    category: row.e.category,
    format: eventFormat({ category: row.e.category, name: row.e.name, venueName: row.v.name }),
    outsideIntent,
    eventId: row.e.id,
    entitySlug: row.ent?.slug ?? null,
    country: row.v.country,
    blockedCategories: env.blockedCategories,
    overrides: env.serviceDepthOverrides,
    now,
  });
}

export async function capabilitiesFor(db: DbOrTx, env: Pick<Env, 'SEATDATA_API_KEY' | 'WATCH_SEND_ENABLED'> & Partial<Pick<Env, 'EMAIL_TEST_RECIPIENT_ALLOWLIST'>>, decision: ServicePolicyDecision, event: { id: string; isFixture: boolean }, now: Date): Promise<{ capabilities: Record<Operation, EventCapabilityDecision>; rights: Record<Operation, EventCapabilityDecision> }> {
  const adapters = await adapterFacts(db);
  const licence = await licenceFacts(db, now);
  // Alerts from SeatData's listings: the licence's alerts use, or tracking while every email goes only to the
  // owner's named testers (internal use, as for market numbers in replies; see marketUses).
  const alerts = licence.tracking && (licence.alerts || (env.EMAIL_TEST_RECIPIENT_ALLOWLIST?.length ?? 0) > 0);
  const [followed] = alerts ? await db.select({ id: t.trackedEvents.id }).from(t.trackedEvents).where(and(eq(t.trackedEvents.eventId, event.id), eq(t.trackedEvents.provider, SEATDATA_PROVIDER), eq(t.trackedEvents.state, 'active'), isNotNull(t.trackedEvents.providerEventId))).limit(1) : [];
  const ctx = { decision, adapters, coveredSourceIds: await coveredSourceIds(db, event, adapters), licence, marketKey: !!env.SEATDATA_API_KEY, watchSendEnabled: env.WATCH_SEND_ENABLED, market: { alerts, covered: !!followed }, now };
  const all = (d: ServicePolicyDecision) => Object.fromEntries(OPERATIONS.map((op) => [op, evaluateOperationCapability({ ...ctx, decision: d }, op)])) as Record<Operation, EventCapabilityDecision>;
  // Rights alone: the same checks with every operation permitted, so shadow and off change nothing.
  return { capabilities: all(decision), rights: all({ ...decision, allowedOperations: [...OPERATIONS] }) };
}

export async function policyForEvent(db: DbOrTx, env: Env, eventId: string, now: Date, outsideIntent: OutsideIntent | null = null): Promise<PolicySnapshot | null> {
  const row = await loadEventRows(db, eventId);
  if (!row) return null;
  const decision = decisionForEvent(env, row, now, outsideIntent);
  return { mode: policyMode(env), decision, ...(await capabilitiesFor(db, env, decision, row.e, now)) };
}

/**
 * Whether an operation may run. Under enforce, business policy and current capability both have to say yes.
 * Under shadow or off, only the capability's rights part is asked for by callers that already checked it, so the
 * answer is the legacy one; a shadow "no" is written to the audit log so the rollout can be read before enforcing.
 */
export async function gate(db: DbOrTx, snap: PolicySnapshot | null, op: Operation, entity: { kind: string; id: string }): Promise<boolean> {
  if (!snap || snap.mode === 'off') return true;
  const permitted = allows(snap.decision, op);
  if (snap.mode === 'enforce') return permitted;
  // Once a day per entity and operation: the tracker and watch workers ask on every pass.
  if (!permitted) {
    const since = new Date(Date.now() - 86_400_000);
    const seen = await db.select({ id: t.auditLog.id }).from(t.auditLog).where(and(eq(t.auditLog.action, 'service_policy.would_block'), eq(t.auditLog.entityId, entity.id), gte(t.auditLog.createdAt, since), sql`${t.auditLog.diff}->>'operation' = ${op}`)).limit(1);
    if (!seen.length) await audit(db, { actor: 'system', action: 'service_policy.would_block', entityKind: entity.kind, entityId: entity.id, diff: { operation: op, depth: snap.decision.depth, category: snap.decision.category, reasons: snap.decision.reasons } });
  }
  return true;
}

/** The snapshot as stored on a request revision or research run. */
export function storedPolicy(snap: PolicySnapshot | null, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
  if (!snap || snap.mode === 'off') return null;
  return { mode: snap.mode, ...snap.decision, capabilities: Object.values(snap.capabilities).map((c) => ({ operation: c.operation, state: c.state, sourceIds: c.sourceIds, reasons: c.reasons })), evaluatedAt: Object.values(snap.capabilities)[0]?.evaluatedAt ?? null, ...extra };
}
