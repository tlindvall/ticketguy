import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { MarketTracker, marketLicence } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID, marketBasketKey } from '@/lib/market/series';

/**
 * SeatData end to end (DECISION_LOG #44) against a fake API shaped like the SDK's payloads: nothing runs
 * until the licence allows it; a customer's event is matched by its Ticketmaster id and polled into our own
 * series; past games at the venue give "typical"; the reply shows market numbers only with display rights;
 * shadow advice is recorded and scored.
 */
const H = 3_600_000;
const KEY = 'cd'.repeat(32);

describe('resale market tracking', () => {
  let h: DbHandle;
  let now = FIXTURE_NOW;
  const calls: string[] = [];
  // The market for our game: every 2 hours over four days, pairs falling from $170 to $130, listings steady.
  let listings = (_i: number) => 400;
  const statsFor = (from: Date, hours: number, a: number, b: number, a2: number, b2: number) =>
    Array.from({ length: hours / 2 + 1 }, (_, i) => {
      const f = i / (hours / 2);
      return { timestamp: new Date(from.getTime() + i * 2 * H).toISOString(), total_listings_all: 600, total_listings_active: listings(i), listing_fill_rate: 0.6, avg_price: 200, median_price: 180, get_in: a + (b - a) * f, get_in_qty2plus: a2 + (b2 - a2) * f, zones: [{ zone_name: 'Lower Bowl', avg_price: 300, median_price: 280, get_in: a + 50, get_in_qty2plus: a2 + 60 }] };
    });
  let liveStats: () => unknown[] = () => statsFor(new Date(now.getTime() - 96 * H), 96, 150, 110, 170, 130);
  const past = [1, 2, 3, 4, 5, 6].map((i) => ({ event_id: 900 + i, event_name: `Metro Testers vs. Team ${i}`, event_date: `2026-0${i < 4 ? 3 : 4}-${String(10 + i).padStart(2, '0')}`, event_time: '19:00:00', venue_name: 'Test Garden', venue_city: 'New York', venue_state: 'NY' }));
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    calls.push(url.pathname + (url.search ? `?${[...url.searchParams.keys()].join(',')}` : ''));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      if (url.searchParams.get('tm_event_id') === 'TMGAME1') return json({ data: [{ event_id: 777, tm_event_id: 'TMGAME1', event_name: 'Metro Testers vs. Boston', event_date: '2026-10-30', venue_name: 'Test Garden', venue_city: 'New York', venue_state: 'NY' }], has_more: false, next_cursor: null });
      if (url.searchParams.get('historical') === 'true') return json({ data: past, has_more: false, next_cursor: null });
      return json({ data: [], has_more: false, next_cursor: null });
    }
    if (url.pathname === '/api/v1/events/777/stats') {
      const since = url.searchParams.get('start_date');
      return json({ event_id: 777, data: liveStats().filter((s) => !since || (s as { timestamp: string }).timestamp.slice(0, 10) >= since), has_more: false, next_cursor: null });
    }
    const m = url.pathname.match(/^\/api\/v1\/events\/(9\d\d)\/stats$/);
    if (m) {
      // Each past game: 40 days of history ending at its start, cheapest $90–$140 depending on the game.
      const g = past.find((p) => String(p.event_id) === m[1])!;
      const start = new Date(`${g.event_date}T23:00:00Z`);
      const base = 80 + (Number(m[1]) - 900) * 10;
      return json({ event_id: Number(m[1]), data: statsFor(new Date(start.getTime() - 40 * 24 * H), 40 * 24, base, base, base + 20, base + 20), has_more: false, next_cursor: null });
    }
    if (url.pathname === '/api/v0.4/events/event-request-add') return json({ job_id: 'job-1' });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const env = (over: Record<string, string> = {}) => testEnv({ SEATDATA_API_KEY: KEY, ...over });
  const tracker = (over: Record<string, string> = {}) => new MarketTracker({ db: h.db, env: env(over), now: () => now, fetchImpl, sleep: async () => {} });
  const concierge = () => new Concierge({ db: h.db, env: env(), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
  const setLicence = (status: string, uses: string[]) => h.db.update(t.marketDatasets).set({ status, approvedUses: uses, licenseReference: 'test: SeatData email 2026-09-29' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  const ask = async (c: Concierge, text: string, from: string) => {
    const r = (await c.ingestInbound(inbound({ text, from, subject: 'Testers' }))) as { requestId: string };
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, now);
    }
    return r.requestId;
  };

  const ARENA = '10000000-0000-4000-8000-0000000000f1';
  const TEAM = '20000000-0000-4000-8000-0000000000f1';
  const GAME = '30000000-0000-4000-8000-0000000000f1';
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Test Garden', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Testers', slug: 'metro-testers', aliases: ['Testers'], league: 'NBA', homeVenueId: ARENA });
    // Not on general sale (so a request is researched, not referred), with a Ticketmaster id to match on.
    await h.db.insert(t.events).values({ id: GAME, name: 'Metro Testers vs. Boston', category: 'nba', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-10-30T23:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    // No listing source: market statistics are all there is, as in production today.
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME, sourceId: 'ticketmaster', sourceEventId: 'TMGAME1', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMGAME1', role: 'discovery', confidence: 'provider_id' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('starts quarantined: a working key alone runs nothing', async () => {
    expect((await marketLicence(h.db)).status).toBe('quarantined');
    expect(await tracker().run()).toMatchObject({ skipped: 'licence_not_approved_for_tracking:quarantined' });
    expect(calls).toHaveLength(0);
  });

  it("with tracking licensed: a customer's event is matched by Ticketmaster id, polled into our own series, and past games give 'typical'", async () => {
    await setLicence('approved', ['tracking', 'benchmark']);
    const c = concierge();
    const requestId = await ask(c, '2 Testers tickets Oct 30 — is resale cheaper?', 'pair@customer.example');
    await c.research({ requestId, revision: 1 });
    const [tr] = await h.db.select().from(t.trackedEvents).where(eq(t.trackedEvents.eventId, GAME));
    expect(tr).toMatchObject({ state: 'active', providerEventId: '777', reasons: ['request'] });
    const pair = await h.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, GAME), eq(t.marketSnapshots.basketKey, marketBasketKey(GAME, 'pair', null))));
    expect(pair).toHaveLength(49);
    expect(pair[0]).toMatchObject({ feeBasis: 'listed_price', quantity: 2, sourceIds: ['seatdata'], datasetId: SEATDATA_DATASET_ID });
    const hist = await h.db.select().from(t.marketHistory);
    expect(new Set(hist.map((r) => r.providerEventId)).size).toBe(6);
    // Staff-only until customer display is licensed: the claim exists, the email does not carry it.
    const [adv] = await h.db.select().from(t.adviceRuns).where(eq(t.adviceRuns.requestId, requestId));
    const claims = (adv!.packet as { claimRecords: Array<{ id: string; customerVisible: boolean; text: string }> }).claimRecords;
    const m = claims.find((x) => x.id === 'C_MARKET')!;
    expect(m.customerVisible).toBe(false);
    expect(m.text).toBe('Resale listings for two tickets together currently start at $130 a ticket (listed price, before fees). That’s down from $160 three days ago. About 400 listings are up.');
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    expect(rec!.bodyText).not.toContain('Resale listings');
  });

  it('with customer display licensed: the reply carries the market numbers and says what they are', async () => {
    await setLicence('approved', ['tracking', 'benchmark', 'advice', 'customer_display']);
    const c = concierge();
    const requestId = await ask(c, '2 Testers tickets Oct 30 — is resale cheaper?', 'shown@customer.example');
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    expect(rec!.bodyText).toContain('Resale listings for two tickets together currently start at $130 a ticket (listed price, before fees).');
    expect(rec!.bodyText).toContain('the cheapest listed price for two together at this point before the game was typically $122.50–$147.50 (median $135)');
    expect(rec!.bodyText).not.toContain('enough comparable history');
    expect(rec!.bodyText).toContain('market statistics from SeatData');
    expect(rec!.bodyText).not.toContain('I can’t see live resale listings');
  });

  it('five together get the listing count, never a price trend', async () => {
    const c = concierge();
    const requestId = await ask(c, '5 Testers tickets Oct 30 together — is resale cheaper?', 'five@customer.example');
    await c.research({ requestId, revision: 1 });
    const [adv] = await h.db.select().from(t.adviceRuns).where(eq(t.adviceRuns.requestId, requestId));
    const claims = (adv!.packet as { claimRecords: Array<{ id: string; kind: string; text: string }> }).claimRecords;
    const m = claims.find((x) => x.id === 'C_MARKET')!;
    expect(m.kind).toBe('market_supply');
    expect(m.text).toContain('That counts all listings, not blocks of 5 seats together.');
    expect(adv!.decision).not.toBe('wait_and_recheck');
  });

  it('the hourly pass asks only for new snapshots, records shadow advice, and scores it a day later', async () => {
    const t0 = now;
    now = new Date(t0.getTime() + 25 * H);
    calls.length = 0;
    // Prices kept falling: the day since, pairs went $130 → $120.
    liveStats = () => [...statsFor(new Date(t0.getTime() - 96 * H), 96, 150, 110, 170, 130), ...statsFor(new Date(t0.getTime() + 2 * H), 22, 108, 100, 128, 120)];
    const r = await tracker().run();
    expect(r).toMatchObject({ polled: 1 });
    expect(calls.filter((c) => c.startsWith('/api/v1/events/777/stats'))).toEqual(['/api/v1/events/777/stats?start_date,limit']);
    const shadows = await h.db.select().from(t.shadowAdvice).where(eq(t.shadowAdvice.eventId, GAME));
    expect(shadows.map((s) => [s.profile, s.decision]).sort()).toEqual([['pair_flexible', 'wait'], ['single_flexible', 'wait']]);
    // Another day: the pair floor settles at $110, so the wait saved $10 a ticket.
    const t1 = now;
    now = new Date(t1.getTime() + 25 * H);
    const before = liveStats;
    liveStats = () => [...before(), ...statsFor(new Date(t1.getTime() + 2 * H), 24, 95, 92, 115, 110)];
    await tracker().run();
    const [pair] = await h.db.select().from(t.shadowAdvice).where(and(eq(t.shadowAdvice.eventId, GAME), eq(t.shadowAdvice.profile, 'pair_flexible'), eq(t.shadowAdvice.decidedAt, t1)));
    expect(pair).toMatchObject({ decision: 'wait', verdict: 'wait_saved', priceCents: 12000 });
    expect(pair!.deltaCents).toBeGreaterThan(0);
  });

  it('shrinking listings flip the call to buy', async () => {
    const t2 = now;
    now = new Date(t2.getTime() + 13 * H);
    listings = (i) => Math.max(50, 400 - i * 30);
    const before = liveStats;
    liveStats = () => [...before(), ...statsFor(new Date(t2.getTime() + H), 12, 90, 85, 108, 100)];
    // Force a poll now.
    await h.db.update(t.trackedEvents).set({ nextPollAt: now }).where(eq(t.trackedEvents.eventId, GAME));
    await tracker().run();
    const rows = await h.db.select().from(t.shadowAdvice).where(and(eq(t.shadowAdvice.eventId, GAME), eq(t.shadowAdvice.decidedAt, now)));
    expect(rows.length).toBeGreaterThan(0);
    for (const s of rows) {
      expect(s.decision).toBe('buy');
      expect(s.reasons).toContain('listings_shrinking');
    }
  });

  it('stops at the daily call budget', async () => {
    await h.db.update(t.trackedEvents).set({ nextPollAt: now }).where(eq(t.trackedEvents.eventId, GAME));
    calls.length = 0;
    const r = await tracker({ SEATDATA_DAILY_CALL_LIMIT: '1' }).run();
    expect(r.polled).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
