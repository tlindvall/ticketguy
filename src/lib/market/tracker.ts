import { and, asc, desc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import type { Env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { eventLocalDate, localTimeInstants } from '@/lib/domain/dates';
import { audit } from '@/lib/util/audit';
import { gate as policyGate, policyForEvent } from '@/lib/intake/service-policy';
import { SeatDataClient, SeatDataError, type SeatDataEvent } from './seatdata';
import { toMarketListing, type MarketListing } from './alternatives';
import { MARKET_METHOD_VERSION, SEATDATA_DATASET_ID, SEATDATA_PROVIDER, basisForQuantity, basisSize, computeMarketContext, isGroupBasis, isOrdinarySeatListing, marketBasketKey, pointsFromListings, pointsFromSnapshot, type MarketBasis, type MarketContext, type SeriesPoint } from './series';

/**
 * Market tracking (DECISION_LOG #44): every event a customer asks about, and the cohort named in
 * MARKET_TRACK_ENTITIES, is matched to SeatData and polled on a schedule that tightens as the event nears.
 * Each poll asks only for snapshots newer than the last one we hold, and stores them as our own market
 * series — the history we keep, within the licence's retention. After each poll the engine records what it
 * would advise standard customers (shadow advice); a later pass scores that against what happened.
 *
 * Nothing runs without the key AND a SeatData licence record approved for "tracking" (/admin/sources). A
 * working key is not permission.
 */

export type LicenceUse = 'tracking' | 'benchmark' | 'advice' | 'customer_display' | 'alerts';

export async function marketLicence(db: DbOrTx): Promise<{ status: string; uses: string[]; allows: (u: LicenceUse) => boolean; row: typeof t.marketDatasets.$inferSelect | null }> {
  const [row] = await db.select().from(t.marketDatasets).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  const uses = row?.approvedUses ?? [];
  const live = row?.status === 'approved' && (!row.rawRetentionUntil || row.rawRetentionUntil > new Date());
  return { status: row?.status ?? 'missing', uses, allows: (u) => !!live && uses.includes(u), row: row ?? null };
}

/**
 * Whether market data may steer advice and appear in emails. The licence switches decide, except while the
 * test allowlist is in force: then every email goes only to the owner's named test addresses, which is internal
 * use (what "tracking" already covers), so the numbers are used and shown there without a second switch. At
 * launch (allowlist emptied) the licence switches alone decide again.
 */
export function marketUses(lic: { allows: (u: LicenceUse) => boolean }, e: Pick<Env, 'EMAIL_TEST_RECIPIENT_ALLOWLIST'>): { advice: boolean; display: boolean; testing: boolean } {
  const testing = lic.allows('tracking') && e.EMAIL_TEST_RECIPIENT_ALLOWLIST.length > 0;
  return { advice: lic.allows('advice') || testing, display: lic.allows('customer_display') || testing, testing: testing && !(lic.allows('advice') && lic.allows('customer_display')) };
}

/** The licence record exists from the first deploy, quarantined, so the owner has something to approve. */
export async function ensureMarketDatasets(db: DbOrTx): Promise<void> {
  await db.insert(t.marketDatasets).values({ id: SEATDATA_DATASET_ID, provider: SEATDATA_PROVIDER, licenseReference: null, approvedUses: [], coverageNote: 'SeatData resale market statistics: cheapest and median listed prices (before fees, per ticket) for any quantity and for 2+, by seating zone; active listing counts.', status: 'quarantined', isFixture: false }).onConflictDoNothing();
}

/** How long until the next poll: daily far out, hourly on the last day, twice as often after a big move. */
export function pollIntervalMinutes(leadMinutes: number, recentMovePct: number | null): number {
  // Each poll is a paid request (about $0.04 pay-as-you-go), and it returns every snapshot since the last one,
  // so polling less often loses no history, only freshness between polls. A customer's request refreshes its
  // event on the spot, so the schedule only has to keep the series and the scorecard current.
  const h = leadMinutes / 60;
  const base = h > 168 ? 24 * 60 : h > 48 ? 12 * 60 : 6 * 60;
  return recentMovePct !== null && Math.abs(recentMovePct) >= 0.1 ? Math.max(3 * 60, base / 2) : base;
}

const SHADOW_EVERY_HOURS = 12;
const SHADOW_CHECK_HOURS = 24;
const SHADOW_PROFILES: Array<{ profile: string; basis: MarketBasis; quantity: number }> = [
  { profile: 'single_flexible', basis: 'single', quantity: 1 },
  { profile: 'pair_flexible', basis: 'pair', quantity: 2 },
];
/** A customer's request re-reads listings for its group when the last read is older than this. */
const GROUP_FRESH_HOURS = 3;
const OPEN_STATES = ['received', 'interpreting', 'needs_clarification', 'resolving_event', 'researching', 'awaiting_review', 'manual_attention', 'recommendation_sent', 'monitoring', 'referred'];
const HISTORY_EVENTS = 8;
const HISTORY_SAMPLE_HOURS = 6;
const HISTORY_REFRESH_DAYS = 30;
const MAX_MATCH_ATTEMPTS = 4;

type EventRow = { e: typeof t.events.$inferSelect; v: typeof t.venues.$inferSelect; ent: typeof t.entities.$inferSelect | null };

export class MarketTracker {
  private client: SeatDataClient | null = null;
  constructor(private readonly deps: { db: DbOrTx; env: Env; now?: () => Date; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {}

  private get db() {
    return this.deps.db;
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private api(): SeatDataClient {
    if (!this.client) this.client = new SeatDataClient(this.deps.env.SEATDATA_API_KEY!, { fetchImpl: this.deps.fetchImpl, sleep: this.deps.sleep });
    return this.client;
  }

  async callsToday(): Promise<number> {
    const now = this.now();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [r] = await this.db.select({ n: sql<number>`coalesce(sum(${t.marketFetches.calls}), 0)::int` }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), gte(t.marketFetches.at, day)));
    return r?.n ?? 0;
  }

  private async log(kind: string, eventId: string | null, status: string, calls: number, points = 0, detail: string | null = null) {
    await this.db.insert(t.marketFetches).values({ provider: SEATDATA_PROVIDER, kind, eventId, status, calls, points, detail: detail?.slice(0, 300) ?? null, at: this.now() });
  }

  /** Why nothing would run, or null when it can. */
  async blocked(): Promise<string | null> {
    if (!this.deps.env.SEATDATA_API_KEY) return 'no_api_key';
    const lic = await marketLicence(this.db);
    if (!lic.allows('tracking')) return `licence_not_approved_for_tracking:${lic.status}`;
    return null;
  }

  /** Follow every upcoming event a customer asked about, and the cohort. Idempotent. */
  async enroll(): Promise<number> {
    const now = this.now();
    const horizon = new Date(now.getTime() + 180 * 86_400_000);
    const fromRequests = await this.db
      .selectDistinct({ id: t.events.id })
      .from(t.requests)
      .innerJoin(t.events, eq(t.events.id, t.requests.eventId))
      .where(and(notInArray(t.requests.state, ['closed', 'unsupported']), gte(t.events.localStartAt, now), lte(t.events.localStartAt, horizon), eq(t.events.isFixture, this.deps.env.APP_MODE === 'fixture')));
    const names = this.deps.env.MARKET_TRACK_ENTITIES;
    const cohort = names.length
      ? await this.db
          .select({ id: t.events.id })
          .from(t.events)
          .innerJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId))
          .where(and(or(inArray(sql`lower(${t.entities.name})`, names), inArray(t.entities.slug, names)), gte(t.events.localStartAt, now), lte(t.events.localStartAt, new Date(now.getTime() + 120 * 86_400_000))))
      : [];
    const want = new Map<string, Set<string>>();
    // A customer's request enrols its event only where the depth invests in tracking (Core, F03); the cohort is
    // staff-approved research and keeps its own reason. A Guide request never quietly promotes its event.
    for (const r of fromRequests) if (await this.requestMayTrack(r.id)) want.set(r.id, new Set(['request']));
    for (const r of cohort) want.set(r.id, new Set([...(want.get(r.id) ?? []), 'cohort']));
    if (!want.size) return 0;
    const existing = await this.db.select().from(t.trackedEvents).where(and(eq(t.trackedEvents.provider, SEATDATA_PROVIDER), inArray(t.trackedEvents.eventId, [...want.keys()])));
    const have = new Map(existing.map((r) => [r.eventId, r]));
    let added = 0;
    for (const [eventId, reasons] of want) {
      const row = have.get(eventId);
      if (!row) {
        await this.db.insert(t.trackedEvents).values({ eventId, provider: SEATDATA_PROVIDER, reasons: [...reasons], nextPollAt: now }).onConflictDoNothing();
        added += 1;
      } else if (row.state === 'paused') {
        // Eligible again (an approved override, a corrected category): resume where it left off.
        await this.db.update(t.trackedEvents).set({ state: row.providerEventId ? 'active' : 'pending_match', pauseReason: null, reasons: [...new Set([...row.reasons, ...reasons])], nextPollAt: now }).where(eq(t.trackedEvents.id, row.id));
      } else if ([...reasons].some((x) => !row.reasons.includes(x))) {
        await this.db.update(t.trackedEvents).set({ reasons: [...new Set([...row.reasons, ...reasons])] }).where(eq(t.trackedEvents.id, row.id));
      }
    }
    return added;
  }

  /** Whether a customer request may keep this event tracked: the service-depth gate (recorded under shadow). */
  private async requestMayTrack(eventId: string): Promise<boolean> {
    const snap = await policyForEvent(this.db, this.deps.env, eventId, this.now());
    return policyGate(this.db, snap, 'market_tracking', { kind: 'event', id: eventId });
  }

  /**
   * The reasons a tracked row still has, judged now (F03): the cohort while the entity is still named in
   * MARKET_TRACK_ENTITIES, a request while an open request for the event exists and its depth allows tracking.
   * The stored reason strings alone are not a justification to keep polling.
   */
  async validReasons(tr: typeof t.trackedEvents.$inferSelect): Promise<string[]> {
    const out: string[] = [];
    if (tr.reasons.includes('cohort')) {
      const names = this.deps.env.MARKET_TRACK_ENTITIES;
      const [hit] = names.length ? await this.db.select({ id: t.events.id }).from(t.events).innerJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId)).where(and(eq(t.events.id, tr.eventId), or(inArray(sql`lower(${t.entities.name})`, names), inArray(t.entities.slug, names)))) : [];
      if (hit) out.push('cohort');
    }
    if (tr.reasons.includes('request')) {
      const [open] = await this.db.select({ id: t.requests.id }).from(t.requests).where(and(eq(t.requests.eventId, tr.eventId), notInArray(t.requests.state, ['closed', 'unsupported']))).limit(1);
      if (open && (await this.requestMayTrack(tr.eventId))) out.push('request');
    }
    return out;
  }

  /** One pass: enrol, then match or poll what is due (customers' events first), then score shadow advice. */
  async run(opts: { limit?: number } = {}): Promise<{ skipped?: string; enrolled: number; matched: number; polled: number; points: number; ended: number; shadow: number; scored: number; budgetLeft: number; paused: number }> {
    const out = { enrolled: 0, matched: 0, polled: 0, points: 0, ended: 0, shadow: 0, scored: 0, budgetLeft: 0, paused: 0 };
    const why = await this.blocked();
    if (why) return { ...out, skipped: why };
    out.enrolled = await this.enroll();
    const now = this.now();
    const limit = this.deps.env.SEATDATA_DAILY_CALL_LIMIT;
    const due = await this.db
      .select()
      .from(t.trackedEvents)
      .where(and(eq(t.trackedEvents.provider, SEATDATA_PROVIDER), inArray(t.trackedEvents.state, ['pending_match', 'requested', 'active']), lte(t.trackedEvents.nextPollAt, now)))
      .orderBy(desc(sql`${t.trackedEvents.reasons} ? 'request'`), asc(t.trackedEvents.nextPollAt))
      .limit(opts.limit ?? 40);
    for (const tr of due) {
      if ((await this.callsToday()) >= limit) {
        await this.log('stats', tr.eventId, 'skipped_budget', 0);
        break;
      }
      // A row whose reasons no longer hold is paused before any provider call; its history stays (F03, SD14).
      if (this.deps.env.SERVICE_POLICY_MODE === 'enforce' && !(await this.validReasons(tr)).length) {
        await this.db.update(t.trackedEvents).set({ state: 'paused', pauseReason: 'policy:no_valid_reason' }).where(eq(t.trackedEvents.id, tr.id));
        await audit(this.db, { actor: 'system', action: 'market.tracking_paused', entityKind: 'event', entityId: tr.eventId, diff: { reasons: tr.reasons } });
        out.paused += 1;
        continue;
      }
      const [ev] = await this.db.select({ e: t.events, v: t.venues, ent: t.entities }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).leftJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId)).where(eq(t.events.id, tr.eventId));
      if (!ev) continue;
      if (ev.e.localStartAt <= now) {
        await this.db.update(t.trackedEvents).set({ state: 'ended' }).where(eq(t.trackedEvents.id, tr.id));
        out.ended += 1;
        continue;
      }
      try {
        let providerEventId = tr.providerEventId;
        if (tr.state !== 'active' || !providerEventId) {
          providerEventId = await this.match(tr, ev);
          if (!providerEventId) continue;
          out.matched += 1;
        }
        const n = await this.poll({ ...tr, providerEventId }, ev);
        out.polled += 1;
        out.points += n;
        out.shadow += await this.recordShadow(ev);
        await this.backfillHistory(ev);
      } catch (e) {
        const msg = e instanceof SeatDataError ? `${e.type}${e.status ? `:${e.status}` : ''}` : e instanceof Error ? e.message : String(e);
        await this.db.update(t.trackedEvents).set({ lastError: msg.slice(0, 300), nextPollAt: new Date(now.getTime() + 60 * 60_000) }).where(eq(t.trackedEvents.id, tr.id));
        await this.log('stats', tr.eventId, 'error', 1, 0, msg);
        if (e instanceof SeatDataError && (e.type === 'authentication_error' || e.type === 'subscription_required' || e.type === 'payment_required')) break; // the account itself is the problem
      }
    }
    out.scored = await this.scoreShadow();
    out.budgetLeft = Math.max(0, limit - (await this.callsToday()));
    return out;
  }

  /**
   * Bring one event's market up to date now, so the first reply to a customer already has SeatData's
   * history for it rather than waiting for the hourly pass. Enrols it; matches and polls it if due.
   */
  async refreshEvent(eventId: string): Promise<{ refreshed: boolean; reason?: string }> {
    const why = await this.blocked();
    if (why) return { refreshed: false, reason: why };
    // A direct refresh is enrolment too: the same depth gate as the scheduled pass (F03).
    if (!(await this.requestMayTrack(eventId))) return { refreshed: false, reason: 'policy' };
    const now = this.now();
    await this.db.insert(t.trackedEvents).values({ eventId, provider: SEATDATA_PROVIDER, reasons: ['request'], nextPollAt: now }).onConflictDoNothing();
    const [tr] = await this.db.select().from(t.trackedEvents).where(and(eq(t.trackedEvents.eventId, eventId), eq(t.trackedEvents.provider, SEATDATA_PROVIDER)));
    if (!tr || !['pending_match', 'requested', 'active'].includes(tr.state)) return { refreshed: false, reason: tr?.state ?? 'missing' };
    if ((await this.callsToday()) >= this.deps.env.SEATDATA_DAILY_CALL_LIMIT) return { refreshed: false, reason: 'budget' };
    if (tr.nextPollAt > now) {
      // The stats are current, but a group of three or more reads listings, and those are only as fresh as the last read.
      if (tr.state !== 'active' || !tr.providerEventId) return { refreshed: false, reason: 'fresh' };
      const sizes = await this.groupSizes(eventId);
      if (!sizes.length || (await this.groupsReadSince(eventId, new Date(now.getTime() - GROUP_FRESH_HOURS * 3_600_000)))) return { refreshed: false, reason: 'fresh' };
      const [ev0] = await this.db.select({ e: t.events, v: t.venues, ent: t.entities }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).leftJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId)).where(eq(t.events.id, eventId));
      if (!ev0 || ev0.e.localStartAt <= now) return { refreshed: false, reason: 'past' };
      try {
        await this.readGroups(tr.providerEventId, ev0, sizes);
        // The read prompted a rescan: pick up the fresh stats soon rather than at the next scheduled check.
        const soon = new Date(now.getTime() + 45 * 60_000);
        if ((!tr.lastObservedAt || now.getTime() - tr.lastObservedAt.getTime() > 2 * 3_600_000) && tr.nextPollAt > soon) await this.db.update(t.trackedEvents).set({ nextPollAt: soon }).where(eq(t.trackedEvents.id, tr.id));
        return { refreshed: true };
      } catch (e) {
        const msg = e instanceof SeatDataError ? `${e.type}${e.status ? `:${e.status}` : ''}` : e instanceof Error ? e.message : String(e);
        await this.log('listings', eventId, 'error', 1, 0, msg);
        return { refreshed: false, reason: msg };
      }
    }
    const [ev] = await this.db.select({ e: t.events, v: t.venues, ent: t.entities }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).leftJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId)).where(eq(t.events.id, eventId));
    if (!ev || ev.e.localStartAt <= now) return { refreshed: false, reason: 'past' };
    try {
      const pid = tr.state === 'active' && tr.providerEventId ? tr.providerEventId : await this.match(tr, ev);
      if (!pid) return { refreshed: false, reason: 'unmatched' };
      await this.poll({ ...tr, providerEventId: pid }, ev);
      await this.backfillHistory(ev);
      return { refreshed: true };
    } catch (e) {
      const msg = e instanceof SeatDataError ? `${e.type}${e.status ? `:${e.status}` : ''}` : e instanceof Error ? e.message : String(e);
      await this.log('stats', eventId, 'error', 1, 0, msg);
      return { refreshed: false, reason: msg };
    }
  }

  /** Find the provider's id for our event: by Ticketmaster id, else by name, date and city; else ask them to add it. */
  private async match(tr: typeof t.trackedEvents.$inferSelect, ev: EventRow): Promise<string | null> {
    const now = this.now();
    const api = this.api();
    const before = api.calls;
    const [m] = await this.db.select({ id: t.eventSourceMappings.sourceEventId }).from(t.eventSourceMappings).where(and(eq(t.eventSourceMappings.eventId, ev.e.id), eq(t.eventSourceMappings.sourceId, 'ticketmaster')));
    const date = eventLocalDate(ev.e.localStartAt, ev.v.timezone);
    let hit: SeatDataEvent | undefined;
    if (m?.id) hit = (await api.searchEvents({ tm_event_id: m.id, limit: 5 })).data?.[0];
    if (!hit) {
      const r = await api.searchEvents({ event_name: (ev.ent?.name ?? ev.e.name) as string, event_date: date, venue_city: ev.v.city ?? undefined, limit: 10 });
      const sameDay = (r.data ?? []).filter((x) => x.event_date?.slice(0, 10) === date);
      hit = sameDay.find((x) => norm(x.venue_name) === norm(ev.v.name)) ?? (sameDay.length === 1 ? sameDay[0] : undefined);
    }
    if (hit) {
      await this.db.update(t.trackedEvents).set({ providerEventId: String(hit.event_id), state: 'active', lastError: null, matchAttempts: tr.matchAttempts + 1 }).where(eq(t.trackedEvents.id, tr.id));
      await this.log('match', ev.e.id, 'success', api.calls - before, 0, String(hit.event_id));
      return String(hit.event_id);
    }
    const attempts = tr.matchAttempts + 1;
    // Asking SeatData to add an event is for the ones a customer is waiting on, once.
    if (tr.matchAttempts === 0 && tr.reasons.includes('request')) {
      await api.requestEvent(`${ev.e.name} ${ev.v.name} ${date}`);
      await this.db.update(t.trackedEvents).set({ state: 'requested', matchAttempts: attempts, nextPollAt: new Date(now.getTime() + 6 * 3_600_000) }).where(eq(t.trackedEvents.id, tr.id));
      await this.log('request_event', ev.e.id, 'success', api.calls - before);
      return null;
    }
    await this.db.update(t.trackedEvents).set({ state: attempts >= MAX_MATCH_ATTEMPTS ? 'unmatched' : tr.state, matchAttempts: attempts, nextPollAt: new Date(now.getTime() + 12 * 3_600_000) }).where(eq(t.trackedEvents.id, tr.id));
    await this.log('match', ev.e.id, 'not_found', api.calls - before);
    return null;
  }

  /** New snapshots since the last one we hold → our own market series. */
  private async poll(tr: typeof t.trackedEvents.$inferSelect & { providerEventId: string }, ev: EventRow): Promise<number> {
    const now = this.now();
    const api = this.api();
    const before = api.calls;
    // Listings for any group of three or more following the event; the read also puts it on SeatData's fast rescan.
    // A failed read is logged and the stats poll goes on: singles and pairs don't depend on it.
    const sizes = await this.groupSizes(ev.e.id);
    let groupsRead = false;
    if (sizes.length) {
      try {
        await this.readGroups(tr.providerEventId, ev, sizes);
        groupsRead = true;
      } catch (e) {
        await this.log('listings', ev.e.id, 'error', 1, 0, e instanceof SeatDataError ? `${e.type}${e.status ? `:${e.status}` : ''}` : e instanceof Error ? e.message : String(e));
      }
    }
    const prompted = groupsRead || (await this.prioritize(tr.providerEventId, ev.e.id));
    const { snapshots } = await api.eventStats(tr.providerEventId, { start_date: tr.lastObservedAt ? tr.lastObservedAt.toISOString().slice(0, 10) : undefined });
    const points = snapshots.flatMap(pointsFromSnapshot).filter((p) => !tr.lastObservedAt || p.observedAt > tr.lastObservedAt);
    await this.storePoints(ev, points);
    const newest = points.reduce<Date | null>((m, p) => (!m || p.observedAt > m ? p.observedAt : m), tr.lastObservedAt);
    const ctx = await this.context(ev.e.id, 'single', ev.e.localStartAt);
    const lead = Math.round((ev.e.localStartAt.getTime() - now.getTime()) / 60_000);
    // Prompting SeatData puts the event on its ~30-minute rescan, but the stats read a moment later can't include
    // it. When what we hold is already hours old, come back once shortly after to pick up the fresh snapshot;
    // a follow-up never schedules another (the previous poll was under 2 hours ago).
    const oldData = !newest || now.getTime() - newest.getTime() > 2 * 3_600_000;
    const followUp = prompted && oldData && (!tr.lastPolledAt || now.getTime() - tr.lastPolledAt.getTime() > 2 * 3_600_000);
    const next = followUp ? 45 : pollIntervalMinutes(lead, ctx.h24?.pct ?? null);
    await this.db.update(t.trackedEvents).set({ lastPolledAt: now, lastObservedAt: newest, lastError: null, nextPollAt: new Date(now.getTime() + next * 60_000) }).where(eq(t.trackedEvents.id, tr.id));
    await this.log('stats', ev.e.id, 'success', api.calls - before, points.length);
    return points.length;
  }

  /**
   * SeatData rescans an event about every 8 hours unless someone asks for its sales or listings, which puts
   * it on a ~30-minute rescan (the probe measured a 479-minute median gap). One small sales call a day keeps
   * a followed event fresh. Failures are ignored: the stats poll still runs on what exists.
   */
  /** True when this call prompted a rescan (false when one was sent in the last 20 hours or it failed). */
  private async prioritize(providerEventId: string, eventId: string): Promise<boolean> {
    const since = new Date(this.now().getTime() - 20 * 3_600_000);
    const [recent] = await this.db.select({ id: t.marketFetches.id }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), inArray(t.marketFetches.kind, ['prioritize', 'listings']), eq(t.marketFetches.eventId, eventId), gte(t.marketFetches.at, since))).limit(1);
    if (recent) return false;
    const api = this.api();
    const before = api.calls;
    try {
      await api.eventSales(providerEventId, { limit: 1 });
      await this.log('prioritize', eventId, 'success', api.calls - before);
      return true;
    } catch {
      await this.log('prioritize', eventId, 'error', api.calls - before);
      return false;
    }
  }

  /** Group sizes (three or more) that open requests for this event are asking about. */
  async groupSizes(eventId: string): Promise<number[]> {
    const reqs = await this.db.select({ id: t.requests.id, rev: t.requests.currentRevision }).from(t.requests).where(and(eq(t.requests.eventId, eventId), inArray(t.requests.state, OPEN_STATES)));
    if (!reqs.length) return [];
    const versions = await this.db.select({ requestId: t.requestVersions.requestId, revision: t.requestVersions.revision, brief: t.requestVersions.brief }).from(t.requestVersions).where(inArray(t.requestVersions.requestId, reqs.map((r) => r.id)));
    const current = new Map(reqs.map((r) => [r.id, r.rev]));
    const sizes = versions.filter((v) => current.get(v.requestId) === v.revision).map((v) => Number((v.brief as { quantity?: unknown } | null)?.quantity)).filter((q) => Number.isInteger(q) && q >= 3);
    return [...new Set(sizes.map((q) => basisSize(basisForQuantity(q))))].sort((a, b) => a - b);
  }

  /**
   * The event's current listings, to set one listing a customer showed us against the rest of the market. One
   * paid request, under the same gates as tracking, only for an event already matched to SeatData. The result
   * is used for this answer and never stored. Wheelchair, companion, parking and suite listings are left out.
   */
  async currentListings(eventId: string, kind: 'listings_compare' | 'listings_watch' = 'listings_compare'): Promise<{ at: Date; listings: MarketListing[] } | null> {
    if (await this.blocked()) return null;
    if ((await this.callsToday()) >= this.deps.env.SEATDATA_DAILY_CALL_LIMIT) return null;
    const [tr] = await this.db.select().from(t.trackedEvents).where(and(eq(t.trackedEvents.eventId, eventId), eq(t.trackedEvents.provider, SEATDATA_PROVIDER)));
    if (!tr || tr.state !== 'active' || !tr.providerEventId) return null;
    const api = this.api();
    const before = api.calls;
    try {
      const r = await api.listings(tr.providerEventId);
      const raw = Array.isArray(r.listings) ? r.listings : [];
      const listings = raw.filter(isOrdinarySeatListing).map(toMarketListing).filter((l): l is MarketListing => l !== null);
      // Its own kind: a comparison read stores no group points, so it must not make the group series look fresh.
      await this.log(kind, eventId, 'success', api.calls - before, listings.length, `${raw.length} listings`);
      return { at: this.now(), listings };
    } catch (e) {
      await this.log(kind, eventId, 'error', api.calls - before, 0, e instanceof SeatDataError ? `${e.type}${e.status ? `:${e.status}` : ''}` : e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /**
   * What a SeatData price watch looks at (DECISION_LOG #62): the cheapest listed price per ticket among active
   * ordinary listings that have at least the party's count, and how many such listings there are. One paid read,
   * under the same licence gates and daily cap as every other read. Null when it can't read; zero listings is an
   * answer, not a failure.
   */
  async listingsForWatch(eventId: string, quantity: number): Promise<{ at: Date; cheapestPerTicketCents: number | null; listings: number } | null> {
    const r = await this.currentListings(eventId, 'listings_watch');
    if (!r) return null;
    const fits = r.listings.filter((l) => l.quantity >= quantity).map((l) => l.priceCents).sort((a, b) => a - b);
    return { at: r.at, cheapestPerTicketCents: fits[0] ?? null, listings: fits.length };
  }

  private async groupsReadSince(eventId: string, since: Date): Promise<boolean> {
    const [r] = await this.db.select({ id: t.marketFetches.id }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), eq(t.marketFetches.kind, 'listings'), eq(t.marketFetches.eventId, eventId), eq(t.marketFetches.status, 'success'), gte(t.marketFetches.at, since))).limit(1);
    return !!r;
  }

  /** Current listings → one point per group size (DECISION_LOG #45). One paid request. */
  private async readGroups(providerEventId: string, ev: EventRow, sizes: number[]): Promise<number> {
    const api = this.api();
    const before = api.calls;
    const r = await api.listings(providerEventId);
    const listings = Array.isArray(r.listings) ? r.listings : [];
    const points = pointsFromListings(listings, sizes, this.now());
    await this.storePoints(ev, points);
    await this.log('listings', ev.e.id, 'success', api.calls - before, points.length, `${listings.length} listings; sizes ${sizes.join(',')}`);
    return points.length;
  }

  private async storePoints(ev: EventRow, points: SeriesPoint[]): Promise<void> {
    const rows = points.map((p) => ({
      datasetId: SEATDATA_DATASET_ID,
      eventId: ev.e.id,
      basketKey: marketBasketKey(ev.e.id, p.basis, p.zone),
      quantity: basisSize(p.basis),
      seatZone: p.zone,
      observedAt: p.observedAt,
      providerAsOf: p.observedAt,
      leadTimeMinutes: Math.round((ev.e.localStartAt.getTime() - p.observedAt.getTime()) / 60_000),
      cheapestEligibleTotalCents: p.priceCents,
      medianEligibleTotalCents: p.medianCents,
      eligibleOptionCount: p.activeListings,
      sourceIds: [SEATDATA_PROVIDER],
      // Listed per-ticket prices before fees: the verified-total trend and benchmark engines exclude this basis.
      feeBasis: 'listed_price',
      coverageComplete: true,
      qualityFlags: ['per_ticket', 'listed_before_fees'],
      observationIds: [],
      methodVersion: MARKET_METHOD_VERSION,
      isFixture: false,
    }));
    for (let i = 0; i < rows.length; i += 200) await this.db.insert(t.marketSnapshots).values(rows.slice(i, i + 200)).onConflictDoNothing();
  }

  /** The market context for one of our events, from the series we hold (and comparables for "typical"). */
  async context(eventId: string, basis: MarketBasis, eventStartAt: Date, zone: string | null = null): Promise<MarketContext> {
    return loadMarketContext(this.db, { eventId, basis, zone, eventStartAt, now: this.now() });
  }

  /**
   * Price history of past games of the same team (or performer) at the same venue, once a month per pair:
   * the "what does this usually cost at this point" layer, so we are not starting blind.
   */
  private async backfillHistory(ev: EventRow): Promise<void> {
    if (!ev.ent) return;
    const now = this.now();
    const key = `${ev.ent.id}:${ev.v.id}`;
    const [recent] = await this.db.select({ id: t.marketFetches.id }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), eq(t.marketFetches.kind, 'history_search'), eq(t.marketFetches.detail, key), gte(t.marketFetches.at, new Date(now.getTime() - HISTORY_REFRESH_DAYS * 86_400_000)))).limit(1);
    if (recent) return;
    if ((await this.callsToday()) + HISTORY_EVENTS + 1 > this.deps.env.SEATDATA_DAILY_CALL_LIMIT) return; // tomorrow
    const api = this.api();
    const before = api.calls;
    const today = eventLocalDate(now, ev.v.timezone);
    const r = await api.searchEvents({ event_name: ev.ent.name, venue_name: ev.v.name, historical: true, limit: 50 });
    const past = (r.data ?? []).filter((x) => x.event_date && x.event_date.slice(0, 10) < today && norm(x.venue_name) === norm(ev.v.name)).sort((a, b) => b.event_date.localeCompare(a.event_date)).slice(0, HISTORY_EVENTS);
    await this.log('history_search', ev.e.id, 'success', api.calls - before, past.length, key);
    for (const p of past) {
      const exists = await this.db.select({ id: t.marketHistory.id }).from(t.marketHistory).where(eq(t.marketHistory.providerEventId, String(p.event_id))).limit(1);
      if (exists.length) continue;
      // Lead times are measured from the start: a start the zone repeats or skips can't be placed, so that
      // event's history is left out rather than shifted an hour (R2-TIME-FOLD-01), before any call is spent on it.
      const starts = localTimeInstants(p.event_date.slice(0, 10), (p.event_time ?? '19:00').slice(0, 5), ev.v.timezone);
      if (starts.length !== 1) continue;
      const start = starts[0]!;
      const b2 = api.calls;
      const { snapshots } = await api.eventStats(p.event_id, { maxPages: 3 });
      const sampled = downsample(snapshots.flatMap(pointsFromSnapshot), HISTORY_SAMPLE_HOURS);
      const rows = sampled.map((pt) => ({ datasetId: SEATDATA_DATASET_ID, providerEventId: String(p.event_id), entityId: ev.ent!.id, venueId: ev.v.id, eventName: p.event_name, eventStartAt: start, basketKey: marketBasketKey(`provider:${p.event_id}`, pt.basis, pt.zone), quantity: pt.basis === 'single' ? 1 : 2, seatZone: pt.zone, observedAt: pt.observedAt, leadTimeMinutes: Math.round((start.getTime() - pt.observedAt.getTime()) / 60_000), priceCents: pt.priceCents, medianCents: pt.medianCents, activeListings: pt.activeListings }));
      for (let i = 0; i < rows.length; i += 200) await this.db.insert(t.marketHistory).values(rows.slice(i, i + 200)).onConflictDoNothing();
      await this.log('history_stats', ev.e.id, 'success', api.calls - b2, rows.length, String(p.event_id));
    }
  }

  /** What the engine would tell a flexible single / pair buyer right now, from market data alone. */
  private async recordShadow(ev: EventRow): Promise<number> {
    const now = this.now();
    const lead = Math.round((ev.e.localStartAt.getTime() - now.getTime()) / 60_000);
    if (lead < SHADOW_CHECK_HOURS * 60 + 6 * 60) return 0; // no room left to wait and still buy
    let n = 0;
    for (const p of SHADOW_PROFILES) {
      const ctx = await this.context(ev.e.id, p.basis, ev.e.localStartAt);
      if (ctx.adequacy !== 'sufficient' || !ctx.current) continue;
      const basketKey = marketBasketKey(ev.e.id, p.basis, null);
      const [last] = await this.db.select({ at: t.shadowAdvice.decidedAt }).from(t.shadowAdvice).where(and(eq(t.shadowAdvice.eventId, ev.e.id), eq(t.shadowAdvice.profile, p.profile))).orderBy(desc(t.shadowAdvice.decidedAt)).limit(1);
      if (last && now.getTime() - last.at.getTime() < SHADOW_EVERY_HOURS * 3_600_000) continue;
      const d = marketDecision(ctx);
      await this.db.insert(t.shadowAdvice).values({ eventId: ev.e.id, basketKey, profile: p.profile, quantity: p.quantity, decidedAt: now, leadTimeMinutes: lead, decision: d.decision, reasons: d.reasons, priceCents: ctx.current.priceCents, activeListings: ctx.supply.now ?? ctx.current.activeListings, checkpointAt: new Date(now.getTime() + SHADOW_CHECK_HOURS * 3_600_000), methodVersion: MARKET_METHOD_VERSION }).onConflictDoNothing();
      n += 1;
    }
    return n;
  }

  /** Score shadow advice whose checkpoint has passed against the series point nearest the checkpoint. */
  async scoreShadow(): Promise<number> {
    const now = this.now();
    const due = await this.db.select().from(t.shadowAdvice).where(and(isNull(t.shadowAdvice.scoredAt), lte(t.shadowAdvice.checkpointAt, now))).limit(200);
    let n = 0;
    for (const s of due) {
      const lo = new Date(s.checkpointAt.getTime() - 4 * 3_600_000);
      const hi = new Date(s.checkpointAt.getTime() + 4 * 3_600_000);
      const pts = await this.db.select({ at: t.marketSnapshots.observedAt, price: t.marketSnapshots.cheapestEligibleTotalCents, count: t.marketSnapshots.eligibleOptionCount }).from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, s.eventId), eq(t.marketSnapshots.basketKey, s.basketKey), gte(t.marketSnapshots.observedAt, lo), lte(t.marketSnapshots.observedAt, hi)));
      const best = pts.filter((p) => p.price !== null).sort((a, b) => Math.abs(a.at.getTime() - s.checkpointAt.getTime()) - Math.abs(b.at.getTime() - s.checkpointAt.getTime()))[0];
      if (!best) {
        if (now.getTime() - s.checkpointAt.getTime() > 12 * 3_600_000) {
          await this.db.update(t.shadowAdvice).set({ verdict: 'no_data', scoredAt: now }).where(eq(t.shadowAdvice.id, s.id));
          n += 1;
        }
        continue;
      }
      const delta = s.priceCents - best.price!; // > 0: the price fell, waiting would have saved this much per ticket
      const verdict = s.decision === 'wait' ? (delta > 0 ? 'wait_saved' : delta < 0 ? 'wait_cost' : 'wait_even') : delta > 0 ? 'buy_regret' : 'buy_right';
      await this.db.update(t.shadowAdvice).set({ outcomePriceCents: best.price, outcomeActiveListings: best.count, outcomeAt: best.at, verdict, deltaCents: delta, scoredAt: now }).where(eq(t.shadowAdvice.id, s.id));
      n += 1;
    }
    return n;
  }
}

/**
 * The market-only call. Wait only when prices for this basis are falling AND listings are not shrinking;
 * everything else is buy. It is deliberately simple, so the scorecard measures one clear rule.
 */
export function marketDecision(ctx: MarketContext): { decision: 'buy' | 'wait'; reasons: string[] } {
  const reasons = [`direction_${ctx.direction}`, `supply_${ctx.supply.trend}`];
  if (ctx.supply.trend === 'shrinking') return { decision: 'buy', reasons: [...reasons, 'listings_shrinking'] };
  if (ctx.direction === 'down') return { decision: 'wait', reasons: [...reasons, 'prices_falling_supply_holding'] };
  return { decision: 'buy', reasons };
}

export async function loadMarketContext(db: DbOrTx, a: { eventId: string; basis: MarketBasis; zone?: string | null; eventStartAt: Date; now: Date }): Promise<MarketContext> {
  const since = new Date(a.now.getTime() - 10 * 86_400_000);
  const basketKey = marketBasketKey(a.eventId, a.basis, a.zone ?? null);
  const rows = await db.select({ at: t.marketSnapshots.observedAt, price: t.marketSnapshots.cheapestEligibleTotalCents, count: t.marketSnapshots.eligibleOptionCount }).from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, a.eventId), eq(t.marketSnapshots.basketKey, basketKey), gte(t.marketSnapshots.observedAt, since), lte(t.marketSnapshots.observedAt, a.now))).orderBy(asc(t.marketSnapshots.observedAt));
  const [ev] = await db.select({ ent: t.events.primaryEntityId, venue: t.events.venueId }).from(t.events).where(eq(t.events.id, a.eventId));
  // Past games' history is kept for singles and pairs only; groups have no "typical" yet.
  const hist = ev?.ent && !isGroupBasis(a.basis)
    ? await db.select({ eventKey: t.marketHistory.providerEventId, lead: t.marketHistory.leadTimeMinutes, price: t.marketHistory.priceCents }).from(t.marketHistory).where(and(eq(t.marketHistory.entityId, ev.ent), eq(t.marketHistory.venueId, ev.venue), eq(t.marketHistory.quantity, basisSize(a.basis)), a.zone ? eq(t.marketHistory.seatZone, a.zone) : isNull(t.marketHistory.seatZone)))
    : [];
  return computeMarketContext({ basis: a.basis, zone: a.zone ?? null, points: rows.filter((r) => r.price !== null).map((r) => ({ observedAt: r.at, priceCents: r.price!, activeListings: r.count })), now: a.now, eventStartAt: a.eventStartAt, comparables: hist.map((h) => ({ eventKey: h.eventKey, leadMinutes: h.lead, priceCents: h.price })) });
}

/**
 * Market signal for a customer's group. A single or a pair reads its own price series; three or more read the
 * series built from listings with at least that many tickets, whose count is also the group's supply signal.
 * Until that series has data, a group falls back to the count of all listings, labelled as such.
 */
export async function marketForGroup(db: DbOrTx, a: { eventId: string; quantity: number; eventStartAt: Date; now: Date }): Promise<{ basis: MarketBasis; context: MarketContext | null; supply: MarketContext['supply']; supplyScope: 'all' | 'group'; single: MarketContext; pair: MarketContext }> {
  const load = (basis: MarketBasis) => loadMarketContext(db, { eventId: a.eventId, basis, eventStartAt: a.eventStartAt, now: a.now });
  const [single, pair] = await Promise.all([load('single'), load('pair')]);
  const basis = basisForQuantity(a.quantity);
  const context = basis === 'single' ? single : basis === 'pair' ? pair : await load(basis);
  // A group's count from a single read is a count without a trend yet; it is still the number that matters.
  const n = context.current?.activeListings ?? null;
  const groupSupply: MarketContext['supply'] | null = !isGroupBasis(basis) ? null : context.supply.now !== null ? context.supply : n !== null && context.current && !context.reasons.some((r) => r.startsWith('stale')) ? { trend: 'unknown', now: n, before: null, hours: null } : null;
  return { basis, context, supply: groupSupply ?? single.supply, supplyScope: groupSupply ? 'group' : 'all', single, pair };
}

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** One point per basket per window, the latest in it: months of 30-minute snapshots are more than a benchmark needs. */
function downsample(points: SeriesPoint[], hours: number): SeriesPoint[] {
  const keep = new Map<string, SeriesPoint>();
  for (const p of points) {
    const k = `${p.basis}|${p.zone ?? ''}|${Math.floor(p.observedAt.getTime() / (hours * 3_600_000))}`;
    const prev = keep.get(k);
    if (!prev || p.observedAt > prev.observedAt) keep.set(k, p);
  }
  return [...keep.values()];
}

/** Delete what the licence no longer lets us keep. Shadow scores are our own derived results and stay. */
export async function purgeExpiredMarketData(db: DbOrTx, now: Date): Promise<{ snapshots: number; history: number }> {
  const lic = await marketLicence(db);
  if (!lic.row?.rawRetentionUntil || lic.row.rawRetentionUntil > now) return { snapshots: 0, history: 0 };
  const s = await db.delete(t.marketSnapshots).where(eq(t.marketSnapshots.datasetId, SEATDATA_DATASET_ID)).returning({ id: t.marketSnapshots.id });
  const h = await db.delete(t.marketHistory).where(eq(t.marketHistory.datasetId, SEATDATA_DATASET_ID)).returning({ id: t.marketHistory.id });
  await audit(db, { actor: 'system', action: 'market.retention_purge', entityKind: 'dataset', entityId: SEATDATA_DATASET_ID, diff: { snapshots: s.length, history: h.length } });
  return { snapshots: s.length, history: h.length };
}
