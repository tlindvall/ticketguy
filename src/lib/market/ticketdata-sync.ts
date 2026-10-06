import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import type { Env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { audit } from '@/lib/util/audit';
import { MARKET_METHOD_VERSION, TICKETDATA_DATASET_ID, TICKETDATA_PROVIDER, marketBasketKey } from './series';
import { TicketDataClient, TicketDataError, TicketDataFixtureClient, type TicketDataHistoryPoint } from './ticketdata';

/**
 * TicketData sync (investigational vendor lead, ADVICE_ENGINE §3): polls the public TicketData price
 * intelligence API and stores its get-in series as our own market history, inside the licence's
 * retention. TicketData get-in prices are ALL-IN per ticket — a different basis from SeatData's
 * listed-before-fees series, so the two providers' rows are never mixed in one basket or trend.
 *
 * Nothing runs without TICKETDATA_ENABLED and a TicketData licence record approved for "tracking"
 * (/admin/sources). A working fetch is not permission, and licence terms must be requested and
 * confirmed before any production reliance — this is not an approved integration.
 *
 * Enrollment is staff-driven while investigational: rows in tracked_events with provider 'ticketdata'
 * are added by staff (the event is already matched to a TicketData event id), not auto-enrolled.
 */

export type TicketDataLicenceUse = 'tracking' | 'benchmark' | 'advice' | 'customer_display' | 'alerts';

export async function ticketDataLicence(db: DbOrTx): Promise<{ status: string; uses: string[]; allows: (u: TicketDataLicenceUse) => boolean; row: typeof t.marketDatasets.$inferSelect | null }> {
  const [row] = await db.select().from(t.marketDatasets).where(eq(t.marketDatasets.id, TICKETDATA_DATASET_ID));
  const uses = row?.approvedUses ?? [];
  const live = row?.status === 'approved' && (!row.rawRetentionUntil || row.rawRetentionUntil > new Date());
  return { status: row?.status ?? 'missing', uses, allows: (u) => !!live && uses.includes(u), row: row ?? null };
}

/** The licence record exists from the first deploy, quarantined, so the owner has something to approve. */
export async function ensureTicketDataDataset(db: DbOrTx): Promise<void> {
  await db
    .insert(t.marketDatasets)
    .values({
      id: TICKETDATA_DATASET_ID,
      provider: TICKETDATA_PROVIDER,
      licenseReference: null,
      approvedUses: [],
      coverageNote: 'TicketData get-in price intelligence (investigational): lowest all-in resale price per event, full price history and per-zone series. Vendor lead only — licence terms not yet requested or confirmed.',
      status: 'quarantined',
      isFixture: false,
    })
    .onConflictDoNothing();
}

export type TicketDataApi = Pick<TicketDataClient, 'getEvent' | 'getPriceHistory' | 'getSections' | 'searchSuggestions'> & { calls: number; callCap: number | null };

export function ticketDataClient(env: Env, opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): TicketDataApi {
  if (env.APP_MODE === 'fixture') return new TicketDataFixtureClient() as unknown as TicketDataApi;
  return new TicketDataClient({ fetchImpl: opts.fetchImpl, baseUrl: opts.baseUrl ?? env.TICKETDATA_BASE_URL });
}

async function callsToday(db: DbOrTx, now: Date): Promise<number> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [r] = await db.select({ n: sql<number>`coalesce(sum(${t.marketFetches.calls}), 0)::int` }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, TICKETDATA_PROVIDER), gte(t.marketFetches.at, day)));
  return r?.n ?? 0;
}

async function log(db: DbOrTx, kind: string, eventId: string | null, status: string, calls: number, points: number, detail: string | null, now: Date) {
  await db.insert(t.marketFetches).values({ provider: TICKETDATA_PROVIDER, kind, eventId, status, calls, points, detail: detail?.slice(0, 600) ?? null, at: now });
}

/** Why nothing would run, or null when it can. */
export async function ticketDataBlocked(db: DbOrTx, env: Env): Promise<string | null> {
  if (!env.TICKETDATA_ENABLED) return 'disabled';
  const lic = await ticketDataLicence(db);
  if (!lic.allows('tracking')) return `licence_not_approved_for_tracking:${lic.status}`;
  return null;
}

/**
 * One event's current get-in price → market_snapshots, single basket only. TicketData publishes one
 * get-in regardless of quantity, so the row is the whole-event entry-price reference (any quantity);
 * pair/group baskets stay absent rather than echoing it as fake quantity-specific data.
 */
export async function syncEventPrice(db: DbOrTx, client: TicketDataApi, a: { eventId: string; providerEventId: string; eventStartAt: Date; now?: Date; isFixture?: boolean }): Promise<{ points: number }> {
  const now = a.now ?? new Date();
  const detail = await client.getEvent(a.providerEventId);
  await log(db, 'price', a.eventId, detail ? 'success' : 'not_found', 1, detail?.getInPriceCents !== null ? 1 : 0, detail ? `get_in ${detail.getInPriceCents ?? 'null'}` : 'no event', now);
  if (!detail || detail.getInPriceCents === null) return { points: 0 };
  const basketKey = marketBasketKey(a.eventId, 'single', null);
  await db
    .insert(t.marketSnapshots)
    .values({
      datasetId: TICKETDATA_DATASET_ID,
      eventId: a.eventId,
      basketKey,
      basketVersion: 1,
      quantity: 1,
      seatZone: null,
      observedAt: now,
      providerAsOf: null,
      retrievedAt: now,
      leadTimeMinutes: Math.round((a.eventStartAt.getTime() - now.getTime()) / 60_000),
      cheapestEligibleTotalCents: detail.getInPriceCents,
      medianEligibleTotalCents: null,
      eligibleOptionCount: null,
      sourceIds: [TICKETDATA_PROVIDER],
      feeBasis: 'verified_total',
      coverageComplete: true,
      qualityFlags: ['all_in', 'per_ticket', 'any_quantity', 'provider_time_unknown'],
      observationIds: [],
      methodVersion: MARKET_METHOD_VERSION,
      isFixture: a.isFixture ?? false,
    })
    .onConflictDoNothing();
  // Per-zone get-in series, for the zones advice hook (best-value section by own history).
  const history = await client.getPriceHistory(a.providerEventId);
  const zones = history.zones.slice(0, 25);
  for (const z of zones) {
    const latest = z.points.filter((p) => p.getInCents !== null).sort((x, y) => y.observedAt.getTime() - x.observedAt.getTime())[0];
    if (!latest?.getInCents) continue;
    await db
      .insert(t.marketSnapshots)
      .values({
        datasetId: TICKETDATA_DATASET_ID,
        eventId: a.eventId,
        basketKey: marketBasketKey(a.eventId, 'single', z.zone),
        basketVersion: 1,
        quantity: 1,
        seatZone: z.zone,
        observedAt: now,
        providerAsOf: null,
        retrievedAt: now,
        leadTimeMinutes: Math.round((a.eventStartAt.getTime() - now.getTime()) / 60_000),
        cheapestEligibleTotalCents: latest.getInCents,
        medianEligibleTotalCents: null,
        eligibleOptionCount: latest.activeListings,
        sourceIds: [TICKETDATA_PROVIDER],
        feeBasis: 'verified_total',
        coverageComplete: true,
        qualityFlags: ['all_in', 'per_ticket', 'any_quantity', 'provider_time_unknown'],
        observationIds: [],
        methodVersion: MARKET_METHOD_VERSION,
        isFixture: a.isFixture ?? false,
      })
      .onConflictDoNothing();
  }
  return { points: 1 + zones.length };
}

/** Downsample a history series to one point per N hours (latest wins), bounding stored rows. */
function downsample(points: TicketDataHistoryPoint[], hours: number): TicketDataHistoryPoint[] {
  const keep = new Map<string, TicketDataHistoryPoint>();
  for (const p of points) {
    const k = String(Math.floor(p.observedAt.getTime() / (hours * 3_600_000)));
    const prev = keep.get(k);
    if (!prev || p.observedAt > prev.observedAt) keep.set(k, p);
  }
  return [...keep.values()].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

/**
 * A past comparable event's full price history → market_history (the benchmark layer's raw material).
 * Past events are not in our catalog, so they are keyed by the provider event id, like SeatData's backfill.
 */
export async function syncEventHistory(db: DbOrTx, client: TicketDataApi, a: { eventId?: string | null; providerEventId: string; entityId?: string | null; venueId?: string | null; eventName: string; eventStartAt: Date; now?: Date; isFixture?: boolean }): Promise<{ rows: number }> {
  const now = a.now ?? new Date();
  const history = await client.getPriceHistory(a.providerEventId);
  const sampled = downsample(
    history.points.filter((p) => p.getInCents !== null),
    6,
  );
  const eventKey = `provider:${a.providerEventId}`;
  const rows = sampled.map((p) => ({
    datasetId: TICKETDATA_DATASET_ID,
    providerEventId: a.providerEventId,
    entityId: a.entityId ?? null,
    venueId: a.venueId ?? null,
    eventName: a.eventName,
    eventStartAt: a.eventStartAt,
    basketKey: marketBasketKey(eventKey, 'single', null),
    quantity: 1,
    seatZone: null,
    observedAt: p.observedAt,
    leadTimeMinutes: Math.round((a.eventStartAt.getTime() - p.observedAt.getTime()) / 60_000),
    priceCents: p.getInCents!,
    medianCents: null as number | null,
    activeListings: p.activeListings,
  }));
  for (let i = 0; i < rows.length; i += 200) await db.insert(t.marketHistory).values(rows.slice(i, i + 200)).onConflictDoNothing();
  await log(db, 'history', a.eventId ?? null, 'success', 1, rows.length, `provider_event ${a.providerEventId}`, now);
  return { rows: rows.length };
}

/**
 * One pass over staff-enrolled TicketData rows (tracked_events, provider 'ticketdata', due now):
 * current get-in for each, plus a one-time history backfill for rows never backfilled. Daily cadence:
 * TicketData history moves slowly and every poll is a budget call.
 */
export async function runTicketDataSync(db: DbOrTx, env: Pick<Env, 'TICKETDATA_ENABLED' | 'TICKETDATA_DAILY_CALL_LIMIT' | 'TICKETDATA_BASE_URL' | 'APP_MODE'>, opts: { limit?: number; now?: Date; fetchImpl?: typeof fetch } = {}): Promise<{ skipped?: string; polled: number; points: number; historyRows: number; budgetLeft: number }> {
  const out = { polled: 0, points: 0, historyRows: 0, budgetLeft: 0 };
  const now = opts.now ?? new Date();
  const why = await ticketDataBlocked(db, env as Env);
  if (why) return { ...out, skipped: why };
  const due = await db
    .select()
    .from(t.trackedEvents)
    .where(and(eq(t.trackedEvents.provider, TICKETDATA_PROVIDER), eq(t.trackedEvents.state, 'active'), lte(t.trackedEvents.nextPollAt, now)))
    .orderBy(asc(t.trackedEvents.nextPollAt))
    .limit(opts.limit ?? 50);
  const client = ticketDataClient(env as Env, { fetchImpl: opts.fetchImpl });
  const isFixture = (env as Env).APP_MODE === 'fixture';
  for (const tr of due) {
    if (!tr.providerEventId) continue;
    if ((await callsToday(db, now)) >= (env as Env).TICKETDATA_DAILY_CALL_LIMIT) {
      await log(db, 'price', tr.eventId, 'skipped_budget', 0, 0, null, now);
      break;
    }
    const [ev] = await db.select({ start: t.events.localStartAt }).from(t.events).where(eq(t.events.id, tr.eventId));
    if (!ev || ev.start <= now) {
      await db.update(t.trackedEvents).set({ state: 'ended' }).where(eq(t.trackedEvents.id, tr.id));
      continue;
    }
    try {
      client.callCap = client.calls + Math.max(0, (env as Env).TICKETDATA_DAILY_CALL_LIMIT - (await callsToday(db, now)));
      const r = await syncEventPrice(db, client, { eventId: tr.eventId, providerEventId: tr.providerEventId, eventStartAt: ev.start, now, isFixture });
      out.polled += 1;
      out.points += r.points;
      // One-time history backfill per tracked row, so benchmarks have something to stand on.
      const [hist] = await db.select({ id: t.marketFetches.id }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, TICKETDATA_PROVIDER), eq(t.marketFetches.kind, 'history'), eq(t.marketFetches.eventId, tr.eventId))).limit(1);
      if (!hist) {
        const h = await syncEventHistory(db, client, { eventId: tr.eventId, providerEventId: tr.providerEventId, eventName: tr.providerEventId, eventStartAt: ev.start, now, isFixture });
        out.historyRows += h.rows;
      }
      await db.update(t.trackedEvents).set({ lastPolledAt: now, lastObservedAt: now, lastError: null, nextPollAt: new Date(now.getTime() + 24 * 3_600_000) }).where(eq(t.trackedEvents.id, tr.id));
    } catch (e) {
      const msg = e instanceof TicketDataError ? `${e.type}${e.status ? `:${e.status}` : ''}` : e instanceof Error ? e.message : String(e);
      await db.update(t.trackedEvents).set({ lastError: msg.slice(0, 300), nextPollAt: new Date(now.getTime() + 6 * 3_600_000) }).where(eq(t.trackedEvents.id, tr.id));
      await log(db, 'price', tr.eventId, 'error', 1, 0, msg, now);
    }
  }
  out.budgetLeft = Math.max(0, (env as Env).TICKETDATA_DAILY_CALL_LIMIT - (await callsToday(db, now)));
  return out;
}

/** Delete what the licence no longer lets us keep. Derived benchmark/trend rows stay; they are recomputed. */
export async function purgeTicketData(db: DbOrTx, now: Date): Promise<{ snapshots: number; history: number }> {
  const lic = await ticketDataLicence(db);
  if (!lic.row?.rawRetentionUntil || lic.row.rawRetentionUntil > now) return { snapshots: 0, history: 0 };
  const s = await db.delete(t.marketSnapshots).where(eq(t.marketSnapshots.datasetId, TICKETDATA_DATASET_ID)).returning({ id: t.marketSnapshots.id });
  const h = await db.delete(t.marketHistory).where(eq(t.marketHistory.datasetId, TICKETDATA_DATASET_ID)).returning({ id: t.marketHistory.id });
  await audit(db, { actor: 'system', action: 'market.retention_purge', entityKind: 'dataset', entityId: TICKETDATA_DATASET_ID, diff: { snapshots: s.length, history: h.length, provider: TICKETDATA_PROVIDER } });
  return { snapshots: s.length, history: h.length };
}
