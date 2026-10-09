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
import { requestTrace, traceSummary } from '@/lib/admin/request-trace';

/**
 * Live, Oct 5 2026: "5 Knicks tickets … $400" for Knicks vs. Orlando Magic got "is on general sale on Ticketmaster. I
 * haven't seen its seats or prices" and "reply compare". An open official sale short-circuited the reply before any
 * prices were read. With a resale feed, the answer is the prices and the seats to buy; the open sale is said inside
 * it. Below, the original take-charge note.
 *
 * Live, Oct 3 2026: "Looking for 4 tickets to the new home game for new york rangers. Max $400" was asked "Which date
 * are you looking at?", then again after "$400 total", then again after "When are they playing home next?". A
 * browser-based assistant answered the same message with the next home game and four seats under budget. Ticket Guy
 * now takes charge: the next home game, said in a line they can correct, and seats for four named from the licensed
 * listings, before fees with the fee allowance said, never as checked or guaranteed.
 */
const KEY = 'cd'.repeat(32);

describe('an open official sale is said inside the priced reply, never instead of it', () => {
  let h: DbHandle;
  const now = FIXTURE_NOW;
  const ARENA = '10000000-0000-4000-8000-0000000005c3';
  const TEAM = '20000000-0000-4000-8000-0000000005c3';
  const games = [5].map((d, i) => ({ id: `30000000-0000-4000-8000-0000000005${(0xc0 + i).toString(16)}`, day: d, provider: String(9900 + i) }));
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
    const r = (await c.ingestInbound(inbound({ text, from: `onsale${seq}@customer.example`, subject: '', receivedAt: now }))) as { requestId: string };
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
    if (process.env.PRINT_HTML) for (const [i, x] of [...sends, ...(rec ? [rec] : [])].entries()) (await import('node:fs')).writeFileSync(`${process.env.PRINT_HTML}/onsale-${seq}-${i}.html`, x.bodyHtml ?? '');
    return { req: req!, emails: [...sends.map((s) => s.bodyText), rec?.bodyText ?? ''].join('\n----\n') };
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Garden Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Knicks', slug: 'metro-knicks-os', aliases: ['Metro Knicks'], league: 'NBA', homeVenueId: ARENA });
    for (const g of games) {
      await h.db.insert(t.events).values({ id: g.id, name: `Metro Knicks vs. Team ${g.day}`, category: 'nba', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date(`2026-10-${String(g.day).padStart(2, '0')}T23:00:00Z`), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z') });
      await h.db.insert(t.eventSourceMappings).values({ eventId: g.id, sourceId: 'ticketmaster', sourceEventId: `TMTC${g.provider}`, authoritativeUrl: `https://www.ticketmaster.com/x/event/TMTC${g.provider}`, role: 'discovery', confidence: 'provider_id' });
    }
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('four tickets for a game on general sale: the seats to buy with the price, and the open sale said; never "reply compare"', async () => {
    const r = await ask('4 tickets to Metro Knicks vs Team 5, max $400 total');
    expect(r.req.eventId).toBe(games[0]!.id);
    expect(r.emails).toMatch(/I’d go for these if checkout comes to about \$\d+ for four\.\n\nSection 214, Row 10/);
    expect(r.emails).toMatch(/\$\d+/);
    // No face value or sale close for this game: the open sale isn't suggested beside the lead (live Oct 6).
    expect(r.emails).not.toMatch(/also lists it as on general sale|can’t see whether it has seats left/);
    expect(r.emails).not.toMatch(/I haven’t seen its seats or prices|reply "compare"/);
    // The admin trace names every outside call: the SeatData listings read, the sellers and the link we sent.
    const trace = await requestTrace(h.db, r.req, { performer: 'Metro Knicks' });
    expect(trace.some((s) => s.source === 'seatdata' && s.status === 'ok')).toBe(true);
    expect(traceSummary(trace).find((x) => x.source === 'seatdata')!.used).toBe(true);
    expect(traceSummary(trace).find((x) => x.source === 'web')!.used).toBe(false);
  });
});
