import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { MarketTracker, loadMarketContext, storeSeriesPoints } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID, pointsFromSnapshot, type MarketContext } from '@/lib/market/series';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { pickListings, type MarketListing } from '@/lib/market/alternatives';

/**
 * Recommendation emails left out the trend and the past-games line while the data existed (Oct 15):
 * (a) the newest snapshot was too old, so the trend was dropped instead of read again;
 * (b) a seating preference with no zone series of its own hid the trend instead of showing the whole venue's, said so;
 * (c) the past-games backfill shared live polling's budget, and a day of polling always left it "tomorrow";
 * (d) past games were only the most recent eight, never the same month in earlier seasons.
 */
const H = 3_600_000;
const KEY = 'ab'.repeat(32);
const snap = (at: Date, single: number, pair = single + 5) => ({ timestamp: at.toISOString(), total_listings_all: 500, total_listings_active: 300, listing_fill_rate: 0.6, avg_price: 200, median_price: 180, get_in: single, get_in_qty2plus: pair, zones: [] });
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe('(a) a stale snapshot is read again before the reply, not dropped', () => {
  let h: DbHandle;
  const now = new Date('2026-10-15T17:00:00Z');
  const VENUE = '10000000-0000-4000-8000-00000000aa15';
  const ACT = '20000000-0000-4000-8000-00000000aa15';
  const SHOW = '30000000-0000-4000-8000-00000000aa15';
  let statsReads = 0;
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/api/v1/events/9915/stats') {
      statsReads += 1;
      return json({ data: [snap(new Date(now.getTime() - 74 * H), 9000), snap(new Date(now.getTime() - 26 * H), 9500), snap(new Date(now.getTime() - H), 10000)], has_more: false, next_cursor: null });
    }
    return json({ data: [], has_more: false, next_cursor: null });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: VENUE, name: 'Pier Hall', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: ACT, kind: 'artist', name: 'Lantern Pilots', slug: 'lantern-pilots', aliases: [], league: null, homeVenueId: null });
    await h.db.insert(t.events).values({ id: SHOW, name: 'Lantern Pilots', category: 'concert', venueId: VENUE, primaryEntityId: ACT, isHome: null, localStartAt: new Date('2026-10-24T01:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    // Matched and polled 30 hours ago; its next scheduled check is tomorrow (a week out polls once a day).
    await h.db.insert(t.trackedEvents).values({ eventId: SHOW, provider: 'seatdata', reasons: ['request'], state: 'active', providerEventId: '9915', lastPolledAt: new Date(now.getTime() - 30 * H), lastObservedAt: new Date(now.getTime() - 30 * H), nextPollAt: new Date(now.getTime() + 10 * H) });
    await storeSeriesPoints(h.db, { id: SHOW, localStartAt: new Date('2026-10-24T01:00:00Z') }, [...pointsFromSnapshot(snap(new Date(now.getTime() - 54 * H), 9000)), ...pointsFromSnapshot(snap(new Date(now.getTime() - 30 * H), 9500))]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('polls it now and the trend is read from the fresh snapshot', async () => {
    const c = new Concierge({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
    const r = (await c.ingestInbound(inbound({ text: 'are lantern pilots tickets going up or down? 2 tickets for oct 23 in brooklyn', from: 'pilot@customer.example', subject: '', receivedAt: now }))) as { requestId: string };
    for (let j = 0; j < 6; j++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(now.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    }
    expect(statsReads).toBe(1);
    const [trace] = await h.db.select({ diff: t.auditLog.diff }).from(t.auditLog).where(and(eq(t.auditLog.action, 'market.trend_assessed'), eq(t.auditLog.entityId, r.requestId)));
    const ctx = (trace!.diff as { context: { reasons: string[]; current: { at: string } } }).context;
    expect(ctx.reasons.some((x) => x.startsWith('stale'))).toBe(false);
    expect(new Date(ctx.current.at).getTime()).toBe(now.getTime() - H);
  });
});

// ---------- packet-level: (b) and (d) ----------
const at = new Date('2026-10-15T16:00:00Z');
const game = new Date('2026-11-16T23:00:00Z');
const listing = (priceCents: number, quantity: number, section: string, row: string): MarketListing => ({ priceCents, quantity, section, row, marketplace: 'stubhub', zone: null }) as MarketListing;
const ctx = (over: Partial<MarketContext>): MarketContext => ({ methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 12000, at: new Date(at.getTime() - 30 * 60_000), activeListings: 40, timeKnown: true }, h24: null, h72: null, direction: 'insufficient', supply: { trend: 'unknown', now: 40, before: null, hours: null }, typical: null, points: 12, ...over });
const args = (market: MarketContext, over: Partial<BuildPacketArgs> = {}) => {
  const chosen = pickListings([listing(12000, 2, '224', '4'), listing(13000, 2, '225', '9')], 2, over.priorities?.budgetTotalCents ?? 40000, 30)!;
  return {
    requestId: 'r', revision: 1, quantity: 2, eventLabel: 'Montreal Canadiens at New York Rangers, Nov 16', eventParts: { title: 'Montreal Canadiens at New York Rangers', where: 'Madison Square Garden, New York', when: 'Mon, Nov 16, 6:00 PM EST' }, eventStartAt: game, headerStartAt: game, timeZone: 'America/New_York', eventCategory: 'nhl', eventNoun: 'game',
    best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: 40000, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
    sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    market: { basis: 'pair', context: market, supply: market.supply, supplyScope: 'group', scope: 'venue', zoneWanted: null, comparableLabel: 'New York Rangers', visible: true },
    picks: { ...chosen, age: 'recent', links: [{ label: 'Event page on StubHub', url: 'https://www.stubhub.com/event/161415584/?quantity=2' }] },
    watchOffer: null,
    ...over,
  } as unknown as BuildPacketArgs;
};
const email = (a: BuildPacketArgs) => {
  const p = buildPacket(a);
  const r = validateAndRender(p, { decision: p.decision, opening: '', paragraphs: [{ claimIds: [], prose: '' }], closing: '' });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.textBody;
};

describe('(b) seats with no zone series of their own: the whole venue’s trend, said so, deciding nothing', () => {
  const rising = ctx({ direction: 'up', h72: { hours: 72, fromCents: 10000, toCents: 12000, changeCents: 2000, pct: 0.2 } });

  it('shows the venue-wide movement with the note, instead of nothing', () => {
    const text = email(args(rising, { seatingPreference: 'club seats' }));
    expect(text).toMatch(/How prices are moving: rising/);
    expect(text).toContain('The cheapest listed pair across the whole venue, before fees, from StubHub and Vivid Seats. No separate series for “club seats”.');
  });

  it('never lets the venue decide for their seats: no “buy, prices are rising”', () => {
    const text = email(args(rising, { seatingPreference: 'club seats' }));
    expect(text).not.toContain('I’d buy these if you’re set on going.');
    expect(text).not.toMatch(/Comparable pairs have risen/);
    // Without a preference the same series is theirs, and it decides as before.
    expect(email(args(rising))).toContain('I’d buy these if you’re set on going.');
  });

  it('over budget, the venue-wide line replaces “not enough price history”', () => {
    const text = email(args(rising, { seatingPreference: 'club seats', priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: 20000, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false } }));
    expect(text).not.toMatch(/I don’t have enough price history/);
    expect(text).toMatch(/I don’t have a separate price series for “club seats”, so this is the whole venue\.|Across every seat in the venue/);
  });
});

describe('(d) same-month comparables beside the most recent games', () => {
  it('says the November games here next to the overall count', () => {
    const falling = ctx({ direction: 'down', h72: { hours: 72, fromCents: 14000, toCents: 12000, changeCents: -2000, pct: -0.14 }, late: { events: 14, fell: 8, rose: 4, held: 2, medianPct: -0.1, leadBucket: '14-45d' }, lateMonth: { events: 6, fell: 5, rose: 1, held: 0, medianPct: -0.2, leadBucket: '14-45d', month: 'November' } });
    const a = args(falling, { priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: 20000, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false }, watchOffer: { until: new Date('2026-11-15T16:00:00Z') } } as Partial<BuildPacketArgs>);
    const text = email(a);
    expect(text).toContain('Late drops happened in 8 of 14 previous games here we tracked. In New York Rangers games here in November, it was 5 of 6, and 1 went up.');
  });
});

describe('(c) the past-games backfill has its own budget, and runs ahead of time; (d) it reads the same month too', () => {
  let h: DbHandle;
  const now = new Date('2026-10-15T15:00:00Z');
  const ARENA = '10000000-0000-4000-8000-00000000cc15';
  const TEAM = '20000000-0000-4000-8000-00000000cc15';
  const GAME = '30000000-0000-4000-8000-00000000cc15';
  const start = new Date('2026-11-16T23:00:00Z');
  // The eight most recent games (Oct 2026 back to spring), then six Novembers from last season, further back.
  const recent = Array.from({ length: 8 }, (_, i) => ({ event_id: 600 + i, event_name: `Harbor Hawks vs. Team ${i}`, event_date: i < 3 ? `2026-10-0${2 + i * 3}` : `2026-04-${String(1 + i * 3).padStart(2, '0')}`, event_time: '19:00:00', venue_name: 'Harbor Arena', venue_city: 'New York', venue_state: 'NY' }));
  const novembers = Array.from({ length: 6 }, (_, i) => ({ event_id: 700 + i, event_name: `Harbor Hawks vs. Club ${i}`, event_date: `2025-11-${String(2 + i * 4).padStart(2, '0')}`, event_time: '19:00:00', venue_name: 'Harbor Arena', venue_city: 'New York', venue_state: 'NY' }));
  const pastById = new Map([...recent, ...novembers].map((p) => [p.event_id, p]));
  let historyCalls = 0;
  const lead = start.getTime() - now.getTime();
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/api/v1/events/search') {
      if (url.searchParams.get('historical') === 'true') {
        historyCalls += 1;
        return json({ data: [...recent, ...novembers], has_more: false, next_cursor: null });
      }
      return json({ data: [{ event_id: 5555, tm_event_id: 'TMHAWKS', event_name: 'Harbor Hawks vs. Boston', event_date: '2026-11-16', venue_name: 'Harbor Arena', venue_city: 'New York', venue_state: 'NY' }], has_more: false, next_cursor: null });
    }
    const m = url.pathname.match(/^\/api\/v1\/events\/(\d+)\/stats$/);
    if (m && pastById.has(Number(m[1]))) {
      historyCalls += 1;
      const g = pastById.get(Number(m[1]))!;
      const s = new Date(`${g.event_date}T23:00:00Z`);
      // November games fell late (100 → 70); the rest rose (100 → 130).
      const end = g.event_date.slice(5, 7) === '11' ? 70 : 130;
      return json({ data: [snap(new Date(s.getTime() - lead), 100, 105), snap(new Date(s.getTime() - 12 * H), end, end + 5)], has_more: false, next_cursor: null });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Harbor Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Harbor Hawks', slug: 'harbor-hawks', aliases: [], league: 'NHL', homeVenueId: ARENA });
    await h.db.insert(t.events).values({ id: GAME, name: 'Harbor Hawks vs. Boston', category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: start, status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME, sourceId: 'ticketmaster', sourceEventId: 'TMHAWKS', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMHAWKS', role: 'discovery', confidence: 'provider_id' });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('live polling spent for the day, the hourly pass still reads the history from its own allowance', async () => {
    // Live polling has already used today's allowance.
    await h.db.insert(t.marketFetches).values({ provider: 'seatdata', kind: 'stats', eventId: null, status: 'success', calls: 5, points: 0, at: new Date(now.getTime() - H) });
    const tracker = new MarketTracker({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY, SEATDATA_DAILY_CALL_LIMIT: '5', SEATDATA_HISTORY_CALL_LIMIT: '30', MARKET_TRACK_ENTITIES: 'harbor-hawks' }), now: () => now, fetchImpl, sleep: async () => {} });
    const r = await tracker.run();
    expect(r.polled).toBe(0);
    expect(r.history).toBe(1);
    // The search and one page for each of the eight recent games and the six Novembers: 15 calls, all history's.
    expect(historyCalls).toBe(15);
    expect(await tracker.callsLeft('live')).toBe(0);
    expect(await tracker.callsLeft('history')).toBe(15);
    const games = await h.db.select({ n: sql<number>`count(distinct ${t.marketHistory.providerEventId})::int` }).from(t.marketHistory);
    expect(games[0]!.n).toBe(14);
    // A second pass the same month reads nothing again.
    historyCalls = 0;
    await tracker.run();
    expect(historyCalls).toBe(0);
  });

  it('(d) the context carries the November games beside the overall set', async () => {
    const c = await loadMarketContext(h.db, { eventId: GAME, basis: 'single', eventStartAt: start, now });
    expect(c.late).toMatchObject({ events: 14, fell: 6, rose: 8 });
    expect(c.lateMonth).toMatchObject({ month: 'November', events: 6, fell: 6, rose: 0 });
  });
});
