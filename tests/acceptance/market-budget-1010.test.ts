import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, testEnv } from '../harness';
import { MarketTracker } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { gate, policyForEvent } from '@/lib/intake/service-policy';

/**
 * SeatData budget accounting from the CTO audit of 2026-10-10 (section 5): the history backfill's guard reserved
 * fewer calls than its loop could spend, so the cap throwing mid-loop read as a stats failure for the live event;
 * failed reads logged one call whatever they attempted (gap 34); a follow-up on a listing link paid for the same
 * listings again because only recentListings consulted the ten-minute cache (gap 42); and gap 35's claim that Core
 * research loses the resale series when only the benchmark use is unapproved, which does not hold.
 */
const H = 3_600_000;
const KEY = 'ef'.repeat(32);
const ARENA = '10000000-0000-4000-8000-0000000010a1';
const TEAM = '20000000-0000-4000-8000-0000000010a1';
const GAME = '30000000-0000-4000-8000-0000000010a1';

describe('SeatData calls are counted as made', () => {
  let h: DbHandle;
  let now = new Date('2026-10-10T15:00:00Z');
  let fetched = 0;
  let listingsReads = 0;
  let statsStatus = 200;
  // Eight past games at the arena, each with three pages of stats: the backfill's most is 1 + 8 * 3 = 25 calls.
  const past = Array.from({ length: 8 }, (_, i) => ({ event_id: 801 + i, event_name: `Budget Testers vs. Team ${i}`, event_date: `2026-04-${String(10 + i).padStart(2, '0')}`, event_time: '19:00:00', venue_name: 'Budget Arena', venue_city: 'New York', venue_state: 'NY' }));
  const snap = (at: Date, price: number) => ({ timestamp: at.toISOString(), total_listings_all: 500, total_listings_active: 300, listing_fill_rate: 0.6, avg_price: 200, median_price: 180, get_in: price, get_in_qty2plus: price + 10, zones: [] });
  const fetchImpl = (async (input: string) => {
    fetched += 1;
    const url = new URL(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      if (url.searchParams.get('tm_event_id') === 'TMBUDGET') return json({ data: [{ event_id: 555, tm_event_id: 'TMBUDGET', event_name: 'Budget Testers vs. Boston', event_date: '2026-11-20', venue_name: 'Budget Arena', venue_city: 'New York', venue_state: 'NY' }], has_more: false, next_cursor: null });
      if (url.searchParams.get('historical') === 'true') return json({ data: past, has_more: false, next_cursor: null });
      return json({ data: [], has_more: false, next_cursor: null });
    }
    if (url.pathname === '/api/v1/events/555/stats') {
      if (statsStatus !== 200) return new Response('{}', { status: statsStatus });
      return json({ data: [snap(new Date(now.getTime() - 2 * H), 150), snap(new Date(now.getTime() - H), 148)], has_more: false, next_cursor: null });
    }
    const m = url.pathname.match(/^\/api\/v1\/events\/(8\d\d)\/stats$/);
    if (m) {
      const g = past.find((p) => String(p.event_id) === m[1])!;
      const start = new Date(`${g.event_date}T23:00:00Z`);
      const page = url.searchParams.get('starting_after');
      const n = page === 'p3' ? 3 : page === 'p2' ? 2 : 1;
      return json({ data: [snap(new Date(start.getTime() - n * 24 * H), 90 + n)], has_more: n < 3, next_cursor: n < 3 ? `p${n + 1}` : null });
    }
    if (url.pathname === '/api/v1/events/555/sales') return json({ data: [], has_more: false, next_cursor: null });
    if (url.pathname === '/api/v0.1.1/listings/get') {
      listingsReads += 1;
      return json({ has_refreshed: true, last_refresh_timestamp: Math.floor(now.getTime() / 1000) - 300, listings: [{ active: true, listing_id: 9001, price: 120, quantity: 4, section: '101', row: '5' }] });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const tracker = (limit: number) => new MarketTracker({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY, SEATDATA_DAILY_CALL_LIMIT: String(limit) }), now: () => now, fetchImpl, sleep: async () => {} });
  const fetches = () => h.db.select().from(t.marketFetches).where(eq(t.marketFetches.eventId, GAME));
  const historyGames = async () => (await h.db.select({ n: sql<number>`count(distinct ${t.marketHistory.providerEventId})::int` }).from(t.marketHistory))[0]!.n;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Budget Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Budget Testers', slug: 'budget-testers', aliases: [], league: 'NBA', homeVenueId: ARENA });
    await h.db.insert(t.events).values({ id: GAME, name: 'Budget Testers vs. Boston', category: 'nba', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-11-21T00:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME, sourceId: 'ticketmaster', sourceEventId: 'TMBUDGET', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMBUDGET', role: 'discovery', confidence: 'provider_id' });
    // Tracking only: no benchmark, advice or display use approved.
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking'], licenseReference: 'test: tracking only' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('history backfill: bounded by what is left, a game the budget cannot cover is skipped_budget, never a stats error', async () => {
    fetched = 0;
    // Match (1), rescan prompt (1), stats (1), history search (1), then three games of three pages: 13 of 15. A fourth
    // game needs three more and only two are left. The old guard (calls + 9 <= 15) started the loop and the cap threw
    // in the fourth game, logged as a 'stats' error with one call and the refresh reported failed.
    const tr = tracker(15);
    expect(await tr.refreshEvent(GAME)).toEqual({ refreshed: true });
    const rows = await fetches();
    expect(rows.filter((r) => r.kind === 'stats' && r.status === 'error')).toHaveLength(0);
    expect(rows.filter((r) => r.kind === 'history_stats' && r.status === 'skipped_budget')).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'history_search')).toMatchObject({ status: 'partial', calls: 1 });
    expect(await historyGames()).toBe(3);
    // Every call made is on record, once: the stats row no longer re-counts the rescan prompt (gap 34).
    expect(fetched).toBe(13);
    expect(await tr.callsToday()).toBe(13);

    // A day later, with room, the partial backfill is picked up where it stopped rather than in 30 days.
    now = new Date(now.getTime() + 25 * H);
    fetched = 0;
    const next = tracker(20);
    expect(await next.refreshEvent(GAME)).toEqual({ refreshed: true });
    expect(await historyGames()).toBe(8);
    expect(await next.callsToday()).toBe(fetched);
    const searches = (await fetches()).filter((r) => r.kind === 'history_search').map((r) => r.status).sort();
    expect(searches).toEqual(['partial', 'success']);
  });

  it('a failed stats read logs the calls it attempted, retries included (audit gap 34)', async () => {
    now = new Date(now.getTime() + 25 * H);
    fetched = 0;
    statsStatus = 503;
    const tr = tracker(50);
    const r = await tr.refreshEvent(GAME);
    statsStatus = 200;
    expect(r.refreshed).toBe(false);
    // The rescan prompt (1) and three attempts at the stats (a 503 is retried twice): the error row says 3, not 1.
    const [err] = (await fetches()).filter((x) => x.kind === 'stats' && x.status === 'error');
    expect(err).toMatchObject({ calls: 3 });
    expect(fetched).toBe(4);
    expect(await tr.callsToday()).toBe(4);
  });

  it('a follow-up comparison reuses a read from the last ten minutes made by another research (audit gap 42)', async () => {
    listingsReads = 0;
    const first = await tracker(50).currentListings(GAME, 'listings_compare');
    expect(first?.listings).toHaveLength(1);
    expect(listingsReads).toBe(1);
    // A new research, its own tracker, five minutes later: the same read, unpaid.
    now = new Date(now.getTime() + 5 * 60_000);
    const again = await tracker(50).currentListings(GAME, 'listings_compare');
    expect(listingsReads).toBe(1);
    expect(again).toEqual(first);
    // A price watch still reads fresh: its alert is about now.
    await tracker(50).currentListings(GAME, 'listings_watch');
    expect(listingsReads).toBe(2);
    // Past the ten minutes, a comparison pays for a new read.
    now = new Date(now.getTime() + 11 * 60_000);
    await tracker(50).currentListings(GAME, 'listings_compare');
    expect(listingsReads).toBe(3);
    expect((await fetches()).filter((x) => x.kind === 'listings_compare').map((x) => x.status)).toEqual(['success', 'success']);
  });

  it('gap 35 not reproduced: under enforce, Core research may refresh the market with the benchmark use unapproved', async () => {
    // research() gates the refresh on may('market_tracking') && may('historical_context'); may() is the depth's
    // allowed operations, not the licence capability, and Core allows both. The benchmark licence only marks the
    // historical_context capability unavailable, which the research gate does not read. The fixture world's synthetic
    // dataset is approved for benchmark, so it is set aside here: no dataset at all allows the benchmark use.
    await h.db.update(t.marketDatasets).set({ status: 'quarantined' }).where(sql`${t.marketDatasets.id} <> ${SEATDATA_DATASET_ID}`);
    const snap = await policyForEvent(h.db, testEnv({ SERVICE_POLICY_MODE: 'enforce', SEATDATA_API_KEY: KEY }), GAME, now);
    expect(snap!.decision.depth).toBe('core');
    expect(snap!.capabilities.historical_context).toMatchObject({ state: 'unavailable', reasons: ['history_use_unapproved'] });
    expect(await gate(h.db, snap, 'historical_context', { kind: 'request', id: GAME })).toBe(true);
    expect(await gate(h.db, snap, 'market_tracking', { kind: 'request', id: GAME })).toBe(true);
    const [row] = await h.db.select().from(t.trackedEvents).where(and(eq(t.trackedEvents.eventId, GAME), eq(t.trackedEvents.state, 'active')));
    expect(row).toBeTruthy();
  });
});
