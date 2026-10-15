import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, RecordingProvider, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { MarketTracker, storeSeriesPoints } from '@/lib/market/tracker';

/**
 * Oct 15, Rangers vs Ducks, 2 tickets, $150 total: the reply had no listing, no link, 15-hour-old prices and a garbled
 * headline. Background tracking had spent the day's SeatData allowance, so the request couldn't read listings.
 * Now: tracking stops at 60% of the day and a request is never blocked by it; a refused read falls back to the game's
 * last listings, said with their age; over budget, the reply names the closest listing with its price, how far over it
 * is and its link, plus another game of the team's that fits from prices already held; the headline says the answer.
 */
const H = 3_600_000;
// Each case its own hour: the tracker's ten-minute shared read cache is per process and keyed by game.
let now = new Date('2026-10-15T17:00:00Z');
const ARENA = '10000000-0000-4000-8000-0000000d0c15';
const TEAM = '20000000-0000-4000-8000-0000000d0c15';
const DUCKS = '30000000-0000-4000-8000-0000000d0c15';
const KINGS = '30000000-0000-4000-8000-0000000e0c15';
const KEY = 'ab'.repeat(32);

type Variant = { background?: number; customer?: number; kept?: boolean; untracked?: boolean };

async function world(v: Variant): Promise<DbHandle> {
  const h = await openTestDb();
  await h.db.insert(t.venues).values({ id: ARENA, name: 'Garden Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
  await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Rangers', slug: 'metro-rangers-dk', aliases: ['Metro Rangers'], league: 'NHL', homeVenueId: ARENA });
  for (const [id, day, vs, tm] of [[DUCKS, '2026-10-19', 'Anaheim Ducks', '8801'], [KINGS, '2026-10-26', 'Los Angeles Kings', '8802']] as const) {
    await h.db.insert(t.events).values({ id, name: `Metro Rangers vs. ${vs}`, category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date(`${day}T23:00:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
    await h.db.insert(t.eventSourceMappings).values({ eventId: id, sourceId: 'ticketmaster', sourceEventId: `TMDK${tm}`, authoritativeUrl: `https://www.ticketmaster.com/x/event/TMDK${tm}`, role: 'discovery', confidence: 'provider_id' });
    if (!(v.untracked && id === DUCKS)) await h.db.insert(t.trackedEvents).values({ eventId: id, provider: 'seatdata', reasons: ['request'], state: 'active', providerEventId: tm, lastPolledAt: new Date(now.getTime() - 15 * H), nextPollAt: new Date(now.getTime() + 5 * H) });
  }
  const pt = (at: Date, cents: number) => [{ basis: 'pair' as const, zone: null, observedAt: at, providerAsOf: at, retrievedAt: at, priceCents: cents, medianCents: null, activeListings: 30 }, { basis: 'single' as const, zone: null, observedAt: at, providerAsOf: at, retrievedAt: at, priceCents: cents - 500, medianCents: null, activeListings: 40 }];
  await storeSeriesPoints(h.db, { id: DUCKS, localStartAt: new Date('2026-10-19T23:00:00Z') }, [...pt(new Date(now.getTime() - 87 * H), 9000), ...pt(new Date(now.getTime() - 39 * H), 9300), ...pt(new Date(now.getTime() - 15 * H), 9500)]);
  // The Kings game, priced 3 hours ago: $55 a ticket for two is about $143 with the 30% fee allowance, inside $150.
  await storeSeriesPoints(h.db, { id: KINGS, localStartAt: new Date('2026-10-26T23:00:00Z') }, pt(new Date(now.getTime() - 3 * H), 5500));
  await h.db.update(t.adapterConfigs).set({ enabled: false });
  await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  if (v.background) await h.db.insert(t.marketFetches).values({ provider: 'seatdata', kind: 'stats', eventId: null, status: 'success', calls: v.background, points: 0, lane: 'background', at: new Date(now.getTime() - 2 * H) });
  if (v.customer) await h.db.insert(t.marketFetches).values({ provider: 'seatdata', kind: 'stats', eventId: null, status: 'success', calls: v.customer, points: 0, lane: 'customer', at: new Date(now.getTime() - H) });
  if (v.kept) await h.db.update(t.trackedEvents).set({ lastListings: [{ priceCents: 9200, quantity: 2, section: '312', row: '8', zone: null, id: '501', marketplace: 'stubhub' }], lastListingsAt: new Date(now.getTime() - 15 * H), lastListingsAsOf: new Date(now.getTime() - 15 * H) }).where(eq(t.trackedEvents.eventId, DUCKS));
  return h;
}

const fetchImpl = (async (input: string) => {
  const url = new URL(input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  if (url.pathname === '/api/v0.1.1/listings/get') return json({ last_refresh_timestamp: Math.floor(now.getTime() / 1000) - 600, listings: [{ active: true, listing_id: 501, price: 92, quantity: 2, section: '312', row: '8', source: 'sh' }, { active: true, listing_id: 502, price: 99, quantity: 2, section: '305', row: '2', source: 'vs' }] });
  if (url.pathname.endsWith('/stats')) return json({ data: [{ timestamp: new Date(now.getTime() - 30 * 60_000).toISOString(), total_listings_all: 400, total_listings_active: 300, listing_fill_rate: 0.6, avg_price: 150, median_price: 130, get_in: 88, get_in_qty2plus: 92, zones: [] }], has_more: false, next_cursor: null });
  return json({ data: [], has_more: false, next_cursor: null });
}) as unknown as typeof fetch;

async function reply(h: DbHandle, provider: RecordingProvider | null = null): Promise<string> {
  const c = new Concierge({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY, STAFF_ALERT_ADDRESSES: 'ops@ticketguy.example' }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: provider, marketFetch: fetchImpl });
  const r = (await c.ingestInbound(inbound({ text: 'Metro Rangers vs Ducks on Oct 19, 2 tickets, $150 total', from: 'duck@customer.example', subject: 'Rangers', receivedAt: now }))) as { requestId: string };
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
  const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
  return rec?.bodyText ?? '';
}

describe('Rangers vs Ducks, 2 tickets, $150: a reply always has a way forward', () => {
  let h: DbHandle;
  afterEach(async () => {
    await h?.close();
    now = new Date(now.getTime() + H);
  });

  it('tracking spent its 60%: the request still reads listings, and the headline says the answer', async () => {
    h = await world({ background: 30 });
    const text = await reply(h);
    expect(text).toContain('Nothing for two under $150 on Oct 19, but Oct 26 vs the Los Angeles Kings fits.');
    // The closest listing, its price, how far over, and its link.
    expect(text).toContain('The closest lead is Section 312, Row 8 on StubHub: about $239 for two tickets, including estimated fees, $89 over.');
    expect(text).toMatch(/Search StubHub for this game: https:\/\/www\.stubhub\.com\/search\?q=Metro%20Rangers%20vs\.%20Anaheim%20Ducks/);
    // The other game that fits, from held prices, with its link, then one question.
    expect(text).toContain('Oct 26 vs the Los Angeles Kings: about $143 for two, including estimated fees, from prices I checked about 3 hours ago.');
    expect(text).toMatch(/Oct 26 vs Los Angeles Kings on StubHub: https:\/\/www\.stubhub\.com\//);
    expect(text).toContain('Would you go up to about $239 for these, or should I look at Oct 26 instead?');
    expect(text).not.toMatch(/left for fees|which leaves/);
    const reads = await h.db.select().from(t.marketFetches).where(and(eq(t.marketFetches.kind, 'listings_compare'), eq(t.marketFetches.status, 'success')));
    expect(reads.map((r) => r.lane)).toEqual(['customer']);
  });

  it('the whole day spent: the game’s last listings, with their age said in one line, and staff told', async () => {
    h = await world({ background: 30, customer: 20, kept: true });
    const provider = new RecordingProvider();
    const text = await reply(h, provider);
    expect(text).toContain('Nothing for two under $150 on Oct 19, but Oct 26 vs the Los Angeles Kings fits.');
    expect(text).toContain('The closest lead is Section 312, Row 8 on StubHub');
    expect(text).toContain('These prices are from about 15 hours ago: I couldn’t refresh them just now, so they may have moved.');
    expect(text).toMatch(/https:\/\/www\.stubhub\.com\//);
    const alerts = provider.sent.filter((m) => m.to === 'ops@ticketguy.example');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toMatch(/a customer's request was refused SeatData reads/);
    expect(alerts[0]!.text).toMatch(/customers' requests 20, background tracking 30 \(capped at 60%\)/);
  });

  it('no listings at all for the game: the other game that fits leads, with links, never market figures alone', async () => {
    h = await world({ untracked: true });
    const text = await reply(h);
    expect(text).toContain('Nothing I can check for two under $150 on Oct 19 yet, but Oct 26 vs the Los Angeles Kings fits: about $143 for two, including estimated fees, from prices I checked about 3 hours ago. Reply with that date and I’ll find seats for two.');
    expect(text).toMatch(/Oct 26 vs Los Angeles Kings on StubHub: https:\/\/www\.stubhub\.com\//);
    expect(text).toMatch(/Search StubHub for this game: https:\/\/www\.stubhub\.com\/search\?q=Metro%20Rangers%20vs\.%20Anaheim%20Ducks/);
  });
});

describe('background tracking is capped at 60% of the day; a customer’s read never is by it', () => {
  it('background stops at 6 of 10, a customer read still runs after that', async () => {
    const h = await world({});
    try {
      const env = testEnv({ SEATDATA_API_KEY: KEY, SEATDATA_DAILY_CALL_LIMIT: '10' });
      await h.db.insert(t.marketFetches).values({ provider: 'seatdata', kind: 'stats', eventId: null, status: 'success', calls: 6, points: 0, lane: 'background', at: new Date(now.getTime() - H) });
      const background = new MarketTracker({ db: h.db, env, now: () => now, fetchImpl, lane: 'background' });
      expect(await background.callsLeft('live')).toBe(0);
      expect(await background.listingsForWatch(DUCKS, 2)).toBeNull();
      const customer = new MarketTracker({ db: h.db, env, now: () => now, fetchImpl });
      expect(await customer.callsLeft('live')).toBe(4);
      const read = await customer.currentListings(DUCKS);
      expect(read?.listings.length).toBe(2);
      expect(read?.kept).toBeUndefined();
      const skipped = await h.db.select().from(t.marketFetches).where(eq(t.marketFetches.status, 'skipped_budget'));
      expect(skipped.map((r) => r.lane)).toEqual(['background']);
    } finally {
      await h.close();
    }
  });
});
