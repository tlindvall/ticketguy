import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { sameDay } from '@/lib/advice/packet';

/**
 * The Red Wings email (live, Oct 2 2026): five tickets from a StubHub event link, on general sale on Ticketmaster,
 * the game a few hours away, and only a count of resale listings (no group price read). It said Ticketmaster three
 * times, called a listing count "resale prices", printed 1928 with no comma, asked for the link they'd sent and a
 * per-ticket budget for five, and ran the whole brief together as one bold line.
 */
const H = 3_600_000;
const KEY = 'ef'.repeat(32);
const NOW = new Date('2026-10-02T19:50:00Z');
const START = new Date('2026-10-02T22:30:00Z');

describe('advice email layout: a same-day game with only a listing count', () => {
  let h: DbHandle;
  const stats = () =>
    Array.from({ length: 37 }, (_, i) => ({ timestamp: new Date(NOW.getTime() - (72 - i * 2) * H).toISOString(), total_listings_all: 3000, total_listings_active: Math.round(2584 - (2584 - 1928) * (i / 36)), listing_fill_rate: 0.6, avg_price: 200, median_price: 180, get_in: 90, get_in_qty2plus: 95, zones: [] }));
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      if (url.searchParams.get('tm_event_id') === 'TMRW1') return json({ data: [{ event_id: 811, tm_event_id: 'TMRW1', event_name: 'Detroit Red Wings vs. New York Rangers', event_date: '2026-10-02', venue_name: 'Little Caesars Arena', venue_city: 'Detroit', venue_state: 'MI' }], has_more: false, next_cursor: null });
      return json({ data: [], has_more: false, next_cursor: null });
    }
    if (url.pathname === '/api/v1/events/811/stats') return json({ event_id: 811, data: stats(), has_more: false, next_cursor: null });
    if (url.pathname === '/api/v0.1.1/listings/get') return new Response('{"error":"boom"}', { status: 500 });
    if (url.pathname === '/api/v1/events/811/sales') return json({ event_id: 811, data: [], has_more: false, next_cursor: null });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const ARENA = '10000000-0000-4000-8000-0000000001a1';
  const TEAM = '20000000-0000-4000-8000-0000000001a1';
  const GAME = '30000000-0000-4000-8000-0000000001a1';
  let rec: { bodyText: string; bodyHtml: string } | undefined;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Little Caesars Arena', city: 'Detroit', state: 'MI', country: 'US', timezone: 'America/Detroit' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Detroit Red Wings', slug: 'detroit-red-wings-0102', aliases: ['Red Wings'], league: 'NHL', homeVenueId: ARENA });
    await h.db.insert(t.events).values({ id: GAME, name: 'Detroit Red Wings vs. New York Rangers', category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: START, status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), publicSaleEndAt: START });
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME, sourceId: 'ticketmaster', sourceEventId: 'TMRW1', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMRW1', role: 'discovery', confidence: 'provider_id' });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    const c = new Concierge({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null, marketFetch: fetchImpl });
    const r = (await c.ingestInbound(inbound({ text: '5 Red Wings tickets tonight https://www.stubhub.com/detroit-red-wings-detroit-tickets-10-2-2026/event/1590001/', from: 'redwings@customer.example', subject: 'Red Wings', receivedAt: NOW }))) as { requestId: string };
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now: NOW })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
    }
    await c.research({ requestId: r.requestId, revision: 1 });
    [rec] = (await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))) as Array<{ bodyText: string; bodyHtml: string }>;
  });
  afterAll(async () => {
    await h.close();
  });

  it('the header is the event in bold, then where, when (tonight) and the party in a lighter line', () => {
    expect(rec!.bodyText.startsWith('Hey,\n\nDetroit Red Wings vs. New York Rangers\nLittle Caesars Arena, Detroit · Tonight at 6:30 p.m. · 5 tickets\n\n')).toBe(true);
    expect(rec!.bodyHtml).toContain('<strong style="font-size:16px;">Detroit Red Wings vs. New York Rangers</strong><br><span style="font-size:14px;color:#6b6b6b;">Little Caesars Arena, Detroit · Tonight at 6:30 p.m. · 5 tickets</span>');
    // An event page told us the game, nothing else: the header doesn't say "from the StubHub link you sent".
    expect(rec!.bodyText).not.toContain('link you sent');
  });

  it('the official sale is the opening, said once, with its link at the end; no model filler', () => {
    const body = rec!.bodyText;
    expect(body).toContain('5 tickets\n\nIt’s on general sale on Ticketmaster. I can’t see whether it has seats left, but if it does, that’s where I’d buy.\n\nThe resale market when I last checked:');
    expect(rec!.bodyHtml).toContain('<p style="margin:0 0 18px;"><strong>It’s on general sale on Ticketmaster.</strong> I can’t see whether it has seats left, but if it does, that’s where I’d buy.</p>');
    expect(body.match(/Ticketmaster/g)).toHaveLength(2);
    expect(body.trim().endsWith('Event page on Ticketmaster: https://www.ticketmaster.com/x/event/TMRW1')).toBe(true);
    expect(body).not.toMatch(/Here’s what I can tell you|place I’d start/);
  });

  it('a listing count is printed as one, with its source, and not called prices', () => {
    expect(rec!.bodyText).toContain('- There are about 1,928 resale listings for this game, down from 2,584 over the last 72 hours. That counts all listings, not blocks of 5 seats together.');
    expect(rec!.bodyText).toContain('That count is from StubHub and Vivid Seats. It isn’t seats I’ve checked, and it can move quickly.');
    expect(rec!.bodyText).not.toContain('resale prices before fees');
  });

  it('the questions ask for what we can use: seats in their words and a total with fees, never a link we can’t open', () => {
    expect(rec!.bodyText).toContain('Two things that would help me narrow it down:\n\n- Found seats you like? Send me the price, section and row (a screenshot works), and I’ll check them.\n- What’s the most you’d pay in total for all 5, fees included?');
    expect(rec!.bodyText).not.toMatch(/send me the link|per ticket\?/i);
  });
});

describe('same-day word', () => {
  it('tonight from 5pm local, today before, nothing on another day or after the start', () => {
    const tz = 'America/Detroit';
    expect(sameDay(new Date('2026-10-02T22:30:00Z'), new Date('2026-10-02T13:00:00Z'), tz)).toBe('Tonight');
    expect(sameDay(new Date('2026-10-02T17:05:00Z'), new Date('2026-10-02T13:00:00Z'), tz)).toBe('Today');
    // 11pm the night before in Detroit is already Oct 2 in UTC: the venue's day decides.
    expect(sameDay(new Date('2026-10-02T22:30:00Z'), new Date('2026-10-02T03:00:00Z'), tz)).toBeNull();
    expect(sameDay(new Date('2026-10-02T22:30:00Z'), new Date('2026-10-02T22:31:00Z'), tz)).toBeNull();
    expect(sameDay(null, new Date(), tz)).toBeNull();
  });
});
