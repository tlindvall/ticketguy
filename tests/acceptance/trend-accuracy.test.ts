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
import { MarketTracker, loadMarketContext } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID, marketBasketKey } from '@/lib/market/series';

/**
 * Trend accuracy end to end (TREND-ACC-01..05), against a fake SeatData shaped like its payloads, through research()
 * into the reply: the provider's time dates an observation and our fetch time never does; a cached read fetched again
 * adds nothing, while an unchanged price the provider saw again is a real point; the day and the three days disagreeing
 * is "mixed", never "flat" or a fall; a venue-wide fall never decides advice about the floor; and every decision leaves
 * a trace of what it was read from.
 */
const H = 3_600_000;
const KEY = 'ef'.repeat(32);

type Snap = { timestamp: string; total_listings_all: number; total_listings_active: number; listing_fill_rate: number; avg_price: number; median_price: number; get_in: number; get_in_qty2plus: number; zones: Array<{ zone_name: string; avg_price: number; median_price: number; get_in: number; get_in_qty2plus: number }> };
/** The `market.trend_assessed` audit diff, as far as these tests read it. */
type Trace = Record<string, unknown> & { context: { adequacy: string; reasons: string[]; h24: unknown; h72: unknown } };
type Claim = { id: string; customerVisible: boolean; text: string; values: Record<string, unknown> };

describe('trend accuracy, through research into the reply', () => {
  let h: DbHandle;
  let now = FIXTURE_NOW;
  const calls: string[] = [];
  /** Pair prices every 2 hours over four days, by hours-before-now: `pair(hoursAgo)` → dollars. */
  const series = (pair: (hoursAgo: number) => number, opts: { endHoursAgo?: number; floor?: (hoursAgo: number) => number } = {}): Snap[] =>
    Array.from({ length: 49 }, (_, i) => {
      const ago = 96 - i * 2 + (opts.endHoursAgo ?? 0);
      const p = pair(ago);
      return { timestamp: new Date(now.getTime() - ago * H).toISOString(), total_listings_all: 600, total_listings_active: 400, listing_fill_rate: 0.6, avg_price: 200, median_price: 180, get_in: p - 20, get_in_qty2plus: p, zones: opts.floor ? [{ zone_name: 'Floor', avg_price: 300, median_price: 280, get_in: opts.floor(ago) - 20, get_in_qty2plus: opts.floor(ago) }] : [{ zone_name: 'Lower Bowl', avg_price: 300, median_price: 280, get_in: p + 30, get_in_qty2plus: p + 40 }] };
    });
  // Each game's provider data, by SeatData event id.
  const stats: Record<string, () => Snap[]> = {};
  const listings: Record<string, () => Record<string, unknown>> = {};
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    calls.push(url.pathname + (url.search ? `?${[...url.searchParams.keys()].join(',')}` : ''));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      const tm = url.searchParams.get('tm_event_id');
      const id = tm?.replace(/^TMTA/, '');
      if (id && stats[id]) return json({ data: [{ event_id: Number(id), tm_event_id: tm, event_name: 'Metro Testers game', event_date: '2026-11-01', venue_name: 'Trend Arena', venue_city: 'New York', venue_state: 'NY' }], has_more: false, next_cursor: null });
      return json({ data: [], has_more: false, next_cursor: null });
    }
    const st = url.pathname.match(/^\/api\/v1\/events\/(\d+)\/stats$/);
    if (st && stats[st[1]!]) {
      const since = url.searchParams.get('start_date');
      return json({ event_id: Number(st[1]), data: stats[st[1]!]!().filter((s) => !since || s.timestamp.slice(0, 10) >= since), has_more: false, next_cursor: null });
    }
    if (url.pathname === '/api/v0.1.1/listings/get') {
      const id = url.searchParams.get('event_id')!;
      return json(listings[id] ? listings[id]!() : { has_refreshed: 0, listings: [] });
    }
    if (/\/sales$/.test(url.pathname)) return json({ data: [], has_more: false, next_cursor: null });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const env = () => testEnv({ SEATDATA_API_KEY: KEY });
  const concierge = () => new Concierge({ db: h.db, env: env(), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
  const tracker = () => new MarketTracker({ db: h.db, env: env(), now: () => now, fetchImpl, sleep: async () => {} });

  const ARENA = '10000000-0000-4000-8000-0000000000a7';
  const TEAM = '20000000-0000-4000-8000-0000000000a7';
  const games: Record<string, string> = {};
  /** One game per scenario, its own day and its own SeatData id, so no scenario reads another's series. */
  const game = async (providerId: string, day: number) => {
    const id = `30000000-0000-4000-8000-0000000${providerId.padStart(5, '0')}`;
    games[providerId] = id;
    await h.db.insert(t.events).values({ id, name: 'Metro Testers vs. Boston', category: 'nba', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date(`2026-11-${String(day).padStart(2, '0')}T23:30:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    await h.db.insert(t.eventSourceMappings).values({ eventId: id, sourceId: 'ticketmaster', sourceEventId: `TMTA${providerId}`, authoritativeUrl: `https://www.ticketmaster.com/x/event/TMTA${providerId}`, role: 'discovery', confidence: 'provider_id' });
    return id;
  };
  let seq = 0;
  const ask = async (text: string) => {
    const c = concierge();
    seq += 1;
    const r = (await c.ingestInbound(inbound({ text, from: `trend${seq}@customer.example`, subject: 'Testers' }))) as { requestId: string };
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, now);
    }
    await c.research({ requestId: r.requestId, revision: 1 });
    const [adv] = await h.db.select().from(t.adviceRuns).where(eq(t.adviceRuns.requestId, r.requestId));
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    const [trace] = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId, r.requestId), eq(t.auditLog.action, 'market.trend_assessed')));
    const claims = (adv!.packet as { claimRecords: Claim[] }).claimRecords;
    return { requestId: r.requestId, adv: adv!, body: rec?.bodyText ?? '', claims, claim: (id: string) => claims.find((c) => c.id === id), trace: trace?.diff as Trace | undefined };
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Trend Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Testers', slug: 'metro-testers-ta', aliases: ['Testers'], league: 'NBA', homeVenueId: ARENA });
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test: SeatData email 2026-09-29' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('mixed: up over three days, down over the last day, is "mixed" through the decision and the reply, never flat or a fall', async () => {
    // $100 three days ago, $150 a day ago, $120 now: +20% over three days, -20% over one.
    stats['5101'] = () => series((ago) => (ago >= 72 ? 100 : ago >= 24 ? 100 + ((72 - ago) / 48) * 50 : 150 - ((24 - ago) / 24) * 30));
    await game('5101', 3);
    const r = await ask('2 Testers tickets Nov 3. Should I buy now or wait? Happy to risk missing out.');
    expect(r.trace).toMatchObject({ scope: 'venue', basis: 'pair', context: { direction: 'mixed', adequacy: 'sufficient', rule: 'h72_up_h24_down' } });
    expect(r.trace!.context.h72).toMatchObject({ fromCents: 10000, toCents: 12000 });
    expect(r.trace!.context.h24).toMatchObject({ fromCents: 15000, toCents: 12000 });
    // Mixed never argues for waiting, even for someone who accepts the risk.
    expect(r.adv.decision).not.toBe('wait_and_recheck');
    expect(r.adv.reasonCodes).toContain('market_mixed_no_clear_direction');
    expect(r.adv.reasonCodes).not.toContain('market_falling_but_risk_tolerance_or_deadline_unknown');
    expect(r.claim('C_MARKET')!.text).toContain('(listed price, before fees), down from $150 a day ago but up from $100 three days ago, so no clear direction.');
    const answer = r.claim('C_TREND_ANSWER')!;
    expect(answer.values).toMatchObject({ supported: 1, source: 'resale_series', direction: 'mixed', scope: 'venue' });
    expect(answer.text).toBe('On buy or wait: I’d buy rather than wait once you find seats that work at a price you’re happy with. Listed resale prices for two or more tickets are at $120 a ticket, down from $150 a day ago but up from $100 three days ago (before fees), so they’ve gone both ways and there’s no clear fall to wait for. You’re willing to risk missing out, but that alone doesn’t show that waiting will save money.');
    expect(r.body).toContain(answer.text);
    expect(r.body).not.toMatch(/About the same as|easing|I don’t have a supported price trend/);
  });

  it('a fall over both windows still reads as a fall (the control for "mixed")', async () => {
    stats['5102'] = () => series((ago) => 170 - ((96 - ago) / 96) * 40);
    await game('5102', 5);
    const r = await ask('2 Testers tickets Nov 5. Should I buy now or wait? Happy to risk missing out.');
    expect(r.trace).toMatchObject({ context: { direction: 'down', rule: 'h72_down_h24_down' }, signal: { basisMatchesGroup: true, direction: 'down' } });
    expect(r.adv.reasonCodes).toContain('market_falling_but_risk_tolerance_or_deadline_unknown');
    expect(r.claim('C_TREND_ANSWER')!.text).toMatch(/^On buy or wait: Listed resale prices for two or more tickets have fallen from \$\d+(?:\.\d\d)? to \$130 a ticket over the last three days \(before fees\)\. That doesn’t tell me they’ll keep falling/);
  });

  it('genuinely unchanged prices are real observations: a held price over four days is "flat" with a window, and says buy', async () => {
    stats['5103'] = () => series(() => 140);
    await game('5103', 7);
    const r = await ask('2 Testers tickets Nov 7. Should I buy now or wait?');
    // Every snapshot the provider dated is a point, though the price never changed: no de-duplication by price.
    const rows = await h.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, games['5103']!), eq(t.marketSnapshots.basketKey, marketBasketKey(games['5103']!, 'pair', null))));
    expect(rows).toHaveLength(49);
    expect(new Set(rows.map((x) => x.cheapestEligibleTotalCents))).toEqual(new Set([14000]));
    expect(rows.every((x) => x.providerAsOf?.getTime() === x.observedAt.getTime() && x.retrievedAt?.getTime() === now.getTime())).toBe(true);
    expect(r.trace).toMatchObject({ context: { direction: 'flat', adequacy: 'sufficient', points: 49 } });
    expect(r.claim('C_TREND_ANSWER')!.text).toBe('On buy or wait: I’d buy rather than wait once you find seats that work at a price you’re happy with. Listed resale prices for two or more tickets have held at about $140 a ticket over the last three days (before fees), so there’s no fall to wait for.');
  });

  it('a cached stats read fetched again adds no history and no freshness', async () => {
    const before = await h.db.select().from(t.marketSnapshots).where(eq(t.marketSnapshots.eventId, games['5103']!));
    const [tr] = await h.db.select().from(t.trackedEvents).where(eq(t.trackedEvents.eventId, games['5103']!));
    // The provider hasn't rescanned: the same 49 snapshots, fetched again two hours later after the poll is due.
    const frozen = stats['5103']!();
    stats['5103'] = () => frozen;
    const at = now;
    now = new Date(at.getTime() + 2 * H);
    await h.db.update(t.trackedEvents).set({ nextPollAt: now }).where(eq(t.trackedEvents.id, tr!.id));
    expect(await tracker().refreshEvent(games['5103']!)).toMatchObject({ refreshed: true });
    const after = await h.db.select().from(t.marketSnapshots).where(eq(t.marketSnapshots.eventId, games['5103']!));
    expect(after).toHaveLength(before.length);
    const ctx = await loadMarketContext(h.db, { eventId: games['5103']!, basis: 'pair', eventStartAt: new Date('2026-11-07T23:30:00Z'), now });
    // The newest observation is still the provider's, two hours old now, not "just now".
    expect(ctx.current!.at.getTime()).toBe(at.getTime());
    now = at;
  });

  it('stale: a series whose newest provider time is 30 hours old never reads as a trend', async () => {
    stats['5104'] = () => series((ago) => 170 - ((126 - ago) / 96) * 40, { endHoursAgo: 30 });
    await game('5104', 9);
    const r = await ask('2 Testers tickets Nov 9. Should I buy now or wait?');
    expect(r.trace!.context.adequacy).toBe('insufficient');
    expect(r.trace!.context.reasons).toContain('stale:30h');
    expect(r.adv.reasonCodes).not.toContain('market_falling_but_risk_tolerance_or_deadline_unknown');
    const answer = r.claim('C_TREND_ANSWER')!;
    expect(answer.values).toMatchObject({ supported: 0, source: 'none' });
    expect(answer.text).toContain('I don’t have a supported price trend for two seats together at this game');
    expect(answer.text).toContain('The newest resale price I have for two or more tickets is from Sep 21, 5:00 AM EDT, too old to say how prices are moving now.');
    expect(r.body).not.toMatch(/easing|about where it was/);
  });

  it('floor prices rising while venue-wide prices fall: the floor answers, the venue is labelled context, and nothing says wait', async () => {
    // Venue pairs fall $170 → $130; floor pairs rise $200 → $260.
    stats['5105'] = () => series((ago) => 170 - ((96 - ago) / 96) * 40, { floor: (ago) => 200 + ((96 - ago) / 96) * 60 });
    await game('5105', 11);
    const r = await ask('2 Testers tickets Nov 11, floor seats. Should I buy now or wait? Happy to risk missing out.');
    expect(r.trace).toMatchObject({ zoneWanted: 'floor', zonesMatched: ['Floor'], scope: 'zone', context: { zone: 'Floor', direction: 'up' }, venue: { zone: null, direction: 'down' }, signal: { basisMatchesGroup: true, direction: 'up', broaderScope: false } });
    expect(r.adv.decision).not.toBe('wait_and_recheck');
    expect(r.adv.reasonCodes).not.toContain('market_falling_but_risk_tolerance_or_deadline_unknown');
    const m = r.claim('C_MARKET')!;
    expect(m.text).toMatch(/^Resale listings with two or more tickets on the floor currently start at \$260 a ticket \(listed price, before fees\), up from \$\d+(?:\.\d\d)? three days ago\. Across every seat in the venue, they start at \$130 before fees, down from \$\d+(?:\.\d\d)? three days ago; that includes seats away from the floor\. About 400 listings are up across the venue\.$/);
    expect(m.values).toMatchObject({ scope: 'zone:floor', direction: 'up' });
    // Their area's figures don't carry the "these cover every seat" caveat; the venue line is the labelled context.
    expect(m.text).not.toContain('don’t reflect your preference');
    expect(r.claim('C_TREND_ANSWER')!.text).toMatch(/^On buy or wait: I’d buy rather than wait once you find seats that work at a price you’re happy with\. Listed resale prices for two or more tickets on the floor have risen from \$\d+(?:\.\d\d)? to \$260 a ticket over the last three days \(before fees\), so waiting hasn’t been paying off\./);
    expect(r.body).not.toMatch(/easing/);
  });

  it('floor wanted, no floor series: a venue-wide fall is broader context, labelled, and never argues for waiting', async () => {
    stats['5106'] = () => series((ago) => 170 - ((96 - ago) / 96) * 40);
    await game('5106', 13);
    const r = await ask('2 Testers tickets Nov 13, floor seats. Should I buy now or wait? Happy to risk missing out.');
    expect(r.trace).toMatchObject({ zoneWanted: 'floor', zonesMatched: [], scope: 'venue', context: { direction: 'down' }, signal: { basisMatchesGroup: false, broaderScope: true } });
    expect(r.adv.reasonCodes).toContain('market_scope_broader_than_request');
    expect(r.adv.reasonCodes).not.toContain('market_falling_but_risk_tolerance_or_deadline_unknown');
    const answer = r.claim('C_TREND_ANSWER')!;
    expect(answer.values).toMatchObject({ supported: 0 });
    expect(answer.text).toMatch(/I don’t have a supported price trend for two seats together at this game.*Across every seat in the venue, listed prices for two or more tickets are at \$130 a ticket before fees, down from \$\d+(?:\.\d\d)? three days ago, but that includes seats outside what you asked for, so I wouldn’t decide on it\./);
    expect(r.claim('C_MARKET')!.text).toContain('These cover every seat in the venue, so they don’t reflect your preference (“floor”).');
    expect(r.body).not.toMatch(/Prices have been easing/);
  });

  it('a listings read without the provider’s refresh time is undated: said as "when I checked", never current, never a trend', async () => {
    stats['5107'] = () => series(() => 140);
    const rows = () => [
      { active: true, listing_id: 1, price: 140, quantity: 6, section: '210', row: '4', zone: 'Upper' },
      { active: true, listing_id: 2, price: 155, quantity: 5, section: '112', row: '2', zone: 'Floor' },
    ];
    listings['5107'] = () => ({ has_refreshed: 1, listings: rows() });
    const id = await game('5107', 15);
    const r = await ask('5 Testers tickets Nov 15 together. Should I buy now or wait?');
    const g = await h.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, id), eq(t.marketSnapshots.basketKey, marketBasketKey(id, 'group:5', null))));
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ providerAsOf: null, cheapestEligibleTotalCents: 14000 });
    expect(g[0]!.retrievedAt!.getTime()).toBe(now.getTime());
    expect(g[0]!.qualityFlags).toContain('provider_time_unknown');
    // Per zone as well: a floor-only group would read its own series.
    const floor = await h.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, id), eq(t.marketSnapshots.basketKey, marketBasketKey(id, 'group:5', 'Floor'))));
    expect(floor.map((x) => x.cheapestEligibleTotalCents)).toEqual([15500]);
    expect(r.trace).toMatchObject({ basis: 'group:5', context: { adequacy: 'insufficient', reasons: ['provider_time_unknown'], points: 0, untimedReads: 1, current: { priceCents: 14000, timeKnown: false } } });
    const m = r.claim('C_MARKET')!;
    expect(m.text).toBe('When I checked, resale listings with 5 or more tickets started at $140 a ticket (listed price, before fees). The listing data doesn’t say how recent it is, so I can’t say which way prices are moving. About 2 listings have 5 or more tickets. Some are bigger blocks that may not split into exactly 5.');
    expect(m.values).toMatchObject({ providerTimeKnown: 0 });
    expect(r.claim('C_TREND_ANSWER')!.text).toContain('The resale listings I read for 5 or more tickets don’t say when they were last refreshed, so I can’t date them or say which way prices are moving.');
    expect(r.body).not.toMatch(/currently start at \$140/);

    // Read again hours later, still undated: a second row, but never a series. Undated reads can't make history.
    now = new Date(now.getTime() + 4 * H);
    await tracker().refreshEvent(id);
    const ctx = await loadMarketContext(h.db, { eventId: id, basis: 'group:5', eventStartAt: new Date('2026-11-15T23:30:00Z'), now });
    expect(ctx).toMatchObject({ adequacy: 'insufficient', points: 0, direction: 'insufficient', observations: { untimed: 2 } });
    now = FIXTURE_NOW;
  });

  it('repeated cached listings reads land on the provider’s refresh time: one observation, the provider’s age, no new history', async () => {
    stats['5108'] = () => series(() => 140);
    const refreshed = new Date(now.getTime() - 5 * H);
    const rows = [{ active: true, listing_id: 1, price: 140, quantity: 6, section: '210', row: '4', zone: 'Upper' }];
    let refreshAt = refreshed;
    listings['5108'] = () => ({ has_refreshed: 0, last_refresh_timestamp: Math.floor(refreshAt.getTime() / 1000), listings: rows });
    const id = await game('5108', 17);
    const r = await ask('5 Testers tickets Nov 17 together. Is resale cheaper?');
    const key = marketBasketKey(id, 'group:5', null);
    const first = await h.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, id), eq(t.marketSnapshots.basketKey, key)));
    expect(first).toHaveLength(1);
    expect(first[0]!.observedAt.getTime()).toBe(refreshed.getTime());
    expect(first[0]!.providerAsOf!.getTime()).toBe(refreshed.getTime());
    expect(first[0]!.retrievedAt!.getTime()).toBe(now.getTime());
    // The trace keeps both times for the observation the reply was read from.
    expect((r.trace!.context as unknown as { observations: unknown[] }).observations).toEqual([{ observedAt: refreshed.toISOString(), providerAsOf: refreshed.toISOString(), retrievedAt: now.toISOString(), priceCents: 14000 }]);
    // Five hours old by the provider's clock, so said as that: not "currently", though we fetched it just now.
    expect(r.claim('C_MARKET')!.text).toMatch(/^As of about 5 hours ago, resale listings with 5 or more tickets started at \$140/);

    // The same cached listings, fetched again four hours later: the same observation, nothing added.
    const t0 = now;
    now = new Date(t0.getTime() + 4 * H);
    await tracker().refreshEvent(id);
    const again = await h.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, id), eq(t.marketSnapshots.basketKey, key)));
    expect(again).toHaveLength(1);
    expect(again[0]!.retrievedAt!.getTime()).toBe(t0.getTime());
    expect((await h.db.select().from(t.marketFetches).where(and(eq(t.marketFetches.eventId, id), eq(t.marketFetches.kind, 'listings')))).length).toBe(2);

    // The provider refreshes; the price hasn't changed. That is a new observation, kept.
    for (const step of [1, 2, 3]) {
      now = new Date(t0.getTime() + (4 + step * 6) * H);
      refreshAt = new Date(now.getTime() - 30 * 60_000);
      await tracker().refreshEvent(id);
    }
    const later = await h.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, id), eq(t.marketSnapshots.basketKey, key)));
    expect(later).toHaveLength(4);
    expect(new Set(later.map((x) => x.cheapestEligibleTotalCents))).toEqual(new Set([14000]));
    const ctx = await loadMarketContext(h.db, { eventId: id, basis: 'group:5', eventStartAt: new Date('2026-11-17T23:30:00Z'), now });
    expect(ctx).toMatchObject({ points: 4, adequacy: 'sufficient', direction: 'flat' });
    now = FIXTURE_NOW;
  });
});
