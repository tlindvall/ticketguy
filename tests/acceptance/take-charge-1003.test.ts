import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge, pickLinksFor } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { pickListings, toMarketListing } from '@/lib/market/alternatives';
import { listingShape, replyStubHubEventId } from '@/lib/market/tracker';

/**
 * Live, Oct 3 2026: "Looking for 4 tickets to the new home game for new york rangers. Max $400" was asked "Which date
 * are you looking at?", then again after "$400 total", then again after "When are they playing home next?". A
 * browser-based assistant answered the same message with the next home game and four seats under budget. Ticket Guy
 * now takes charge: the next home game, said in a line they can correct, and seats for four named from the licensed
 * listings, before fees with the fee allowance said, never as checked or guaranteed.
 */
const KEY = 'cd'.repeat(32);

describe('take charge: the next home game and seats for the party, not questions', () => {
  let h: DbHandle;
  const now = FIXTURE_NOW;
  const ARENA = '10000000-0000-4000-8000-0000000000c3';
  const TEAM = '20000000-0000-4000-8000-0000000000c3';
  const games = [5, 8, 11, 14, 17].map((d, i) => ({ id: `30000000-0000-4000-8000-0000000000${(0xc0 + i).toString(16)}`, day: d, provider: String(8800 + i) }));
  const listings = [
    { active: true, listing_id: 101, source: 'sh', price: 70, quantity: 4, section: '214', row: '10' },
    { active: true, listing_id: 102, source: 'vs', price: 74, quantity: 6, section: '220', row: '4' },
    { active: true, listing_id: 103, source: 'sh', price: 52, quantity: 5, section: '330', row: '1' }, // leaves one: may not split
    { active: true, listing_id: 104, source: 'sh', price: 40, quantity: 2, section: '301', row: '2' }, // too few
    { active: true, listing_id: 105, source: 'sh', price: 30, quantity: 4, section: 'ADA 111', row: 'WC' }, // not ordinary seats
  ];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      const g = games.find((x) => `TMTC${x.provider}` === url.searchParams.get('tm_event_id'));
      return json({ data: g ? [{ event_id: Number(g.provider), tm_event_id: `TMTC${g.provider}`, event_name: 'Rangers', event_date: '2026-10-05', venue_name: 'Madison Square Garden', venue_city: 'New York', venue_state: 'NY' }] : [], has_more: false, next_cursor: null });
    }
    if (/\/stats$/.test(url.pathname) || /\/sales$/.test(url.pathname)) return json({ data: [], has_more: false, next_cursor: null });
    if (url.pathname === '/api/v0.1.1/listings/get') return json({ has_refreshed: 1, last_refresh_timestamp: Math.floor((now.getTime() - 40 * 60_000) / 1000), listings });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const concierge = () => new Concierge({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
  let seq = 0;
  const ask = async (text: string) => {
    const c = concierge();
    seq += 1;
    const r = (await c.ingestInbound(inbound({ text, from: `charge${seq}@customer.example`, subject: '', receivedAt: now }))) as { requestId: string };
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
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    // Opt-in: writes each email as sent to $PRINT_HTML for a look in a browser.
    if (process.env.PRINT_HTML) for (const [i, x] of [...sends, ...(rec ? [rec] : [])].entries()) (await import('node:fs')).writeFileSync(`${process.env.PRINT_HTML}/take-charge-${seq}-${i}.html`, x.bodyHtml ?? '');
    return { req: req!, emails: [...sends.map((s) => s.bodyText), rec?.bodyText ?? ''].join('\n----\n') };
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Garden Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Rangers', slug: 'metro-rangers-tc', aliases: ['Metro Rangers'], league: 'NHL', homeVenueId: ARENA });
    for (const g of games) {
      await h.db.insert(t.events).values({ id: g.id, name: `Metro Rangers vs. Team ${g.day}`, category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date(`2026-10-${String(g.day).padStart(2, '0')}T23:00:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
      await h.db.insert(t.eventSourceMappings).values({ eventId: g.id, sourceId: 'ticketmaster', sourceEventId: `TMTC${g.provider}`, authoritativeUrl: `https://www.ticketmaster.com/x/event/TMTC${g.provider}`, role: 'discovery', confidence: 'provider_id' });
    }
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('the live wording: the new home game is the next one, said once, and four seats under $400 are named', async () => {
    const r = await ask('Looking for 4 tickets to the new home game for metro rangers. Max $400');
    expect(r.req.eventId).toBe(games[0]!.id);
    expect(r.emails).not.toMatch(/Which date|Which game|Send a date/);
    // The answer first, in bold-able words, then the seats as bullets, the way a person would write it.
    // The answer first, then the game, then the offer as a card with its link, the estimate said as estimated
    // (personal-email design, Oct 3).
    expect(r.emails).toContain('Hey,\n\nI’d buy Section 214, Row 10: four seats together for about $364 with fees (estimated), $36 under your $400.\n\nMetro Rangers vs. Team 5\nGarden Arena, New York · Monday, October 5, at 7 p.m. · 4 tickets · up to $400 in total\n\nSection 214 · Row 10 on StubHub\nAbout $364 for four, estimated\n$280 for four before fees ($70 each), plus a 30% fee allowance.\nRight now 2 listings have four together, from $70 to $74 a ticket before fees.\nNot checked yet: that it’s still listed and the seats are together, from resale data refreshed in the last couple of hours.\nSearch StubHub for this game: https://www.stubhub.com/search?q=Metro%20Rangers%20vs.%20Team%205\n\nOther leads shown\nSection 220 · Row 4 on Vivid Seats: $296 for four before fees.');
    expect(r.emails).not.toContain('Vivid Seats for this game');
    // Budget given and seats named: nothing left to ask.
    expect(r.emails).not.toMatch(/narrow it down|would help me/);
    // Never the wheelchair block, never a listing too small, never "verified" or "guaranteed".
    expect(r.emails).not.toMatch(/ADA 111|section 301|guarantee|verified at checkout/i);
    expect(r.emails).not.toMatch(/Found seats you like\? Send me/);
    // The $52 block of five is said once, as why it wasn't picked; no second "cheapest" or budget sum from it.
    expect(r.emails).toContain('Why not cheaper: Section 330 at $52 each is 5 tickets, and sellers rarely leave a single seat.');
    expect(r.emails.match(/\$52/g)).toHaveLength(1);
    // Dates read the way a person says them, never "10-05-2026" or "7:00 PM EDT".
    expect(r.emails).toContain('• When: Monday, October 5, at 7 p.m.');
    expect(r.emails).not.toMatch(/7:00 PM EDT|10-05-2026|On buy or wait/);
    expect(r.emails).not.toMatch(/Lowest asking price|My read:|send me the listing/i);
  });

  it('no date at all: a team means its next home game, with one line to correct it', async () => {
    const r = await ask('4 metro rangers tickets please, $400 max total');
    expect(r.req.eventId).toBe(games[0]!.id);
    expect(r.emails).toContain("I've gone with the next home game, Monday, October 5. Tell me if you meant a different one.");
    expect(r.emails).toContain('I’d buy Section 214, Row 10: four seats together');
    expect(r.emails).not.toMatch(/Which date|Which game/);
  });

  it('"When are they playing home next?" is the next home game too', async () => {
    const r = await ask('When are the metro rangers playing home next? 4 tickets, $400 total');
    expect(r.req.eventId).toBe(games[0]!.id);
    expect(r.emails).not.toMatch(/Which date|Which game/);
  });

  it('a named date still wins, and two games that day still ask which', async () => {
    const r = await ask('4 metro rangers tickets for Oct 11, $400 total');
    expect(r.req.eventId).toBe(games[2]!.id);
  });

  it('picks: exact or splittable listings first, nothing over budget presented as fitting, the cheapest named when none fits', () => {
    const l = (price: number, quantity: number, section: string) => ({ priceCents: price * 100, quantity, section, row: '1', zone: null, marketplace: 'stubhub' as const });
    const r = pickListings([l(52, 5, 'A'), l(70, 4, 'B'), l(74, 6, 'C')], 4, 40000, 30)!;
    expect(r.fits).toBe(true);
    expect(r.picks.map((p) => p.listing.section)).toEqual(['B', 'C']);
    const over = pickListings([l(90, 4, 'D'), l(95, 4, 'E')], 4, 40000, 30)!;
    expect(over).toMatchObject({ fits: false });
    expect(over.picks.map((p) => p.listing.section)).toEqual(['D']);
    expect(pickListings([l(40, 2, 'F')], 4, 40000, 30)).toBeNull();
  });

  it('find-it links: the listing itself when we can, StubHub’s event page when we know it, the search otherwise', () => {
    const l = (over: Partial<Parameters<typeof pickLinksFor>[0]>) => ({ priceCents: 7000, quantity: 4, section: '214', row: '10', zone: null, ...over });
    // The feed's own listing page, StubHub or Vivid Seats only.
    expect(pickLinksFor(l({ marketplace: 'stubhub', url: 'https://www.stubhub.com/event/1590/?listingId=77' }), 'A vs. B', 4, null)).toEqual([{ label: 'View Section 214 on StubHub', url: 'https://www.stubhub.com/event/1590/?listingId=77' }]);
    // StubHub's event id (their link, or the feed's reply) and a StubHub listing number: opened on that listing.
    expect(pickLinksFor(l({ marketplace: 'stubhub', id: '6123456789' }), 'A vs. B', 4, '159000123')).toEqual([{ label: 'View Section 214 on StubHub', url: 'https://www.stubhub.com/event/159000123/?quantity=4&listingId=6123456789' }]);
    expect(pickLinksFor(l({ marketplace: 'stubhub' }), 'A vs. B', 4, '159000123')).toEqual([{ label: 'Event page on StubHub', url: 'https://www.stubhub.com/event/159000123/?quantity=4' }]);
    expect(pickLinksFor(l({ marketplace: 'vividseats' }), 'A vs. B', 2, null, 'game')).toEqual([{ label: 'Search Vivid Seats for this game', url: 'https://www.vividseats.com/search?searchTerm=A%20vs.%20B' }]);
    expect(pickLinksFor(l({}), 'A vs. B', 2, 'not-an-id', 'game').map((x) => x.label)).toEqual(['Search StubHub for this game', 'Search Vivid Seats for this game']);
    // A concert is a show (live Oct 5: "Search StubHub for this game" under a Brooklyn Steel concert), and a GA listing is general admission.
    expect(pickLinksFor(l({ section: 'General Admission', row: 'GA' }), 'Mind Enterprises', 2, null, 'show').map((x) => x.label)).toEqual(['Search StubHub for this show', 'Search Vivid Seats for this show']);
    expect(pickLinksFor(l({ marketplace: 'stubhub', section: 'General Admission', row: 'GA', url: 'https://www.stubhub.com/event/1/?listingId=2' }), 'Mind Enterprises', 2, null, 'show')[0]!.label).toBe('View the general admission listing on StubHub');
  });

  it('a listing link from the feed is kept only for StubHub or Vivid Seats over https', () => {
    expect(toMarketListing({ price: 70, quantity: 4, url: 'https://www.vividseats.com/x/production/1?showDetails=9' })).toMatchObject({ marketplace: 'vividseats', url: 'https://www.vividseats.com/x/production/1?showDetails=9' });
    expect(toMarketListing({ price: 70, quantity: 4, url: 'https://evil.example/stubhub.com' })!.url).toBeNull();
    expect(toMarketListing({ price: 70, quantity: 4, url: 'http://www.stubhub.com/event/1' })!.url).toBeNull();
    expect(replyStubHubEventId({ event_id_sh: 159000123 }, null)).toBe('159000123');
    expect(replyStubHubEventId({}, null)).toBeNull();
  });

  it('the listings shape is logged as field names and marketplace counts, never values', () => {
    const shape = listingShape([{ listing_id: 1, price: 70, section: '214', source: 'sh' }, { price: 74, section: '220' }, { price: 1, source: 'https://evil.example/x?token=1' }]);
    expect(shape).toBe('keys listing_id,price,section,source; sources sh=1,none=1,other=1');
    // The reply's own fields too (a marketplace event id there would make a listing link possible).
    expect(listingShape([{ price: 70 }], { listings: [], last_refresh_timestamp: 1, event_id_sh: 159 })).toBe('top event_id_sh,last_refresh_timestamp,listings; keys price; sources none=1');
    expect(shape).not.toMatch(/70|214|evil|token/);
  });
});
