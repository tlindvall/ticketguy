import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Audit 2026-10-10 gaps 10 and 28, through research with mocked SeatData listings: "$300 before fees" is held against the
 * listed total (it was held against the 30 percent fee estimate, so four seats listed at $280 read as over budget), and
 * "best view" / "cheapest is fine" order the seats named, said in the picks line. A view is claimed only from the section
 * and row the listings give; without them the picks are by price and the email says so.
 */
const KEY = 'ef'.repeat(32);

describe('a budget’s fee basis and what "best" means reach the seats we name', () => {
  let h: DbHandle;
  const now = FIXTURE_NOW;
  const ARENA = '10000000-0000-4000-8000-0000000000e7';
  const TEAM = '20000000-0000-4000-8000-0000000000e7';
  const GAME = { id: '30000000-0000-4000-8000-0000000000e7', provider: '9701' };
  const BARE = { id: '30000000-0000-4000-8000-0000000000e8', provider: '9702' };
  const seated = [
    { active: true, listing_id: 201, source: 'sh', price: 70, quantity: 4, section: '214', row: '10' },
    { active: true, listing_id: 202, source: 'vs', price: 74, quantity: 6, section: '220', row: '4' },
    { active: true, listing_id: 203, source: 'sh', price: 95, quantity: 4, section: '112', row: '15' },
    { active: true, listing_id: 204, source: 'sh', price: 52, quantity: 5, section: '330', row: '1' }, // leaves one
  ];
  // The second game's feed says nothing about where its seats are.
  const unplaced = [
    { active: true, listing_id: 301, source: 'sh', price: 80, quantity: 4 },
    { active: true, listing_id: 302, source: 'sh', price: 66, quantity: 4 },
  ];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      const g = [GAME, BARE].find((x) => `TMGF${x.provider}` === url.searchParams.get('tm_event_id'));
      return json({ data: g ? [{ event_id: Number(g.provider), tm_event_id: `TMGF${g.provider}`, event_name: 'Rangers', event_date: g === GAME ? '2026-10-05' : '2026-10-08', venue_name: 'Garden Arena', venue_city: 'New York', venue_state: 'NY' }] : [], has_more: false, next_cursor: null });
    }
    if (/\/stats$/.test(url.pathname) || /\/sales$/.test(url.pathname)) return json({ data: [], has_more: false, next_cursor: null });
    if (url.pathname === '/api/v0.1.1/listings/get') return json({ has_refreshed: 1, last_refresh_timestamp: Math.floor((now.getTime() - 40 * 60_000) / 1000), listings: url.searchParams.get('event_id') === BARE.provider ? unplaced : seated });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const concierge = () => new Concierge({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
  let seq = 0;
  const ask = async (text: string) => {
    const c = concierge();
    seq += 1;
    const r = (await c.ingestInbound(inbound({ text, from: `goal${seq}@customer.example`, subject: '', receivedAt: now }))) as { requestId: string };
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
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const [version] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    return { req: req!, brief: version!.brief as RequestExtraction, emails: [...sends.map((s) => s.bodyText), rec?.bodyText ?? ''].join('\n----\n') };
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Garden Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Rangers', slug: 'metro-rangers-gf', aliases: ['Metro Rangers'], league: 'NHL', homeVenueId: ARENA });
    for (const [g, day] of [[GAME, 5], [BARE, 8]] as const) {
      await h.db.insert(t.events).values({ id: g.id, name: `Metro Rangers vs. Team ${day}`, category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date(`2026-10-0${day}T23:00:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
      await h.db.insert(t.eventSourceMappings).values({ eventId: g.id, sourceId: 'ticketmaster', sourceEventId: `TMGF${g.provider}`, authoritativeUrl: `https://www.ticketmaster.com/x/event/TMGF${g.provider}`, role: 'discovery', confidence: 'provider_id' });
    }
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('gap 10: "$300 before fees" fits four seats listed at $280, said on the same basis', async () => {
    const r = await ask('4 metro rangers tickets for Oct 5, $300 total before fees');
    expect(r.req.eventId).toBe(GAME.id);
    expect(r.brief.budgetFeeBasis).toBe('before_fees');
    expect(r.emails).toContain('I’d go for these if checkout comes to about $364 for four.');
    expect(r.emails).toContain('Section 214, Row 10 on StubHub: $280 for four tickets before fees, about $364 with estimated fees, $20 under your $300 before fees.');
    expect(r.emails).not.toMatch(/I haven’t found a confirmed|over before fees/);
    expect(r.emails).not.toMatch(/[–—]|guarantee/i);
  });

  it('gap 10: "$300 all-in" is the checkout total, so the $280 seats ($364 with fees) are not offered as fitting', async () => {
    const r = await ask('4 metro rangers tickets for Oct 5, $300 all-in');
    expect(r.brief.budgetFeeBasis).toBe('all_in');
    // Only the block of five comes in under it with the fee estimate.
    expect(r.emails).toContain('Section 330, Row 1 on StubHub: about $270 for four tickets, including estimated fees, $30 under your $300.');
    expect(r.emails).not.toContain('Section 214, Row 10');
  });

  it('gap 28: "best view" leads with the lowest section within budget, and says how it picked', async () => {
    const r = await ask('4 metro rangers tickets for Oct 5, best view, $500 total');
    expect(r.brief.rankingGoal).toBe('view');
    expect(r.emails).toContain('Section 112, Row 15 on StubHub: about $494 for four tickets, including estimated fees, $6 under your $500.');
    expect(r.emails).toContain('Picked for the view: lower sections and rows first, going only by the section and row each listing gives.');
    expect(r.emails).not.toContain('Why not cheaper');
  });

  it('gap 28: "cheapest is fine" leads with the cheapest that seats them', async () => {
    const r = await ask('4 metro rangers tickets for Oct 5, $500 total, cheapest is fine');
    expect(r.brief.rankingGoal).toBe('price');
    expect(r.emails).toContain('Section 330, Row 1 on StubHub: about $270 for four tickets, including estimated fees');
    expect(r.emails).toContain('It’s a listing of 5, so check it sells as 4.');
    expect(r.emails).toContain('Picked on price: the lowest listed prices for your number.');
  });

  it('no goal: today’s order and no goal line', async () => {
    const r = await ask('4 metro rangers tickets for Oct 5, $500 total');
    expect(r.brief.rankingGoal).toBeNull();
    expect(r.emails).toContain('Section 214, Row 10 on StubHub: about $364 for four tickets');
    expect(r.emails).not.toMatch(/Picked (?:for|on|by)/);
  });

  it('gap 28: "best view" where the listings don’t say where the seats are: by price, and said so', async () => {
    const r = await ask('4 metro rangers tickets for Oct 8, best view, $500 total');
    expect(r.req.eventId).toBe(BARE.id);
    expect(r.emails).toContain('Picked by price: these listings don’t say enough about where the seats are to pick for the view.');
    expect(r.emails).not.toContain('Picked for the view');
  });
});
