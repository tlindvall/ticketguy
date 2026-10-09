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
import { eventNounFor, seatPhrase } from '@/lib/domain/event-noun';

/**
 * Live, Oct 5 2026: two tickets for Mind Enterprises (16 and Over) at Brooklyn Steel got "I'd buy Section General
 * Admission, Row GA … Search StubHub for this game · Search Vivid Seats for this game". A concert is a show, and a
 * general-admission listing is general admission, not a section and row.
 */
const KEY = 'cd'.repeat(32);

describe('a concert is a show, and GA is general admission', () => {
  let h: DbHandle;
  const now = FIXTURE_NOW;
  const STEEL = '10000000-0000-4000-8000-0000000007c1';
  const ACT = '20000000-0000-4000-8000-0000000007c1';
  const SHOW = '30000000-0000-4000-8000-0000000007c1';
  const listings = [
    { active: true, listing_id: 201, source: 'sh', price: 43.04, quantity: 2, section: 'General Admission', row: 'GA' },
    { active: true, listing_id: 202, source: 'vs', price: 43.72, quantity: 2, section: 'General Admission', row: 'GA' },
    { active: true, listing_id: 203, source: 'sh', price: 44.04, quantity: 4, section: 'General Admission', row: 'GA' },
  ];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') return json({ data: url.searchParams.get('tm_event_id') === 'TMSTEEL1' ? [{ event_id: 4401, tm_event_id: 'TMSTEEL1', event_name: 'Mind Enterprises (16 and Over)', event_date: '2026-10-10', venue_name: 'Brooklyn Steel', venue_city: 'Brooklyn', venue_state: 'NY' }] : [], has_more: false, next_cursor: null });
    if (/\/stats$/.test(url.pathname) || /\/sales$/.test(url.pathname)) return json({ data: [], has_more: false, next_cursor: null });
    if (url.pathname === '/api/v0.1.1/listings/get') return json({ has_refreshed: 1, last_refresh_timestamp: Math.floor((now.getTime() - 40 * 60_000) / 1000), listings });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: STEEL, name: 'Brooklyn Steel', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: ACT, kind: 'artist', name: 'Mind Enterprises', slug: 'mind-enterprises-1005', aliases: [] });
    await h.db.insert(t.events).values({ id: SHOW, name: 'Mind Enterprises (16 and Over)', category: 'concert', genre: 'electronic / indie dance', venueId: STEEL, primaryEntityId: ACT, localStartAt: new Date('2026-10-11T01:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
    await h.db.insert(t.eventSourceMappings).values({ eventId: SHOW, sourceId: 'ticketmaster', sourceEventId: 'TMSTEEL1', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMSTEEL1', role: 'discovery', confidence: 'provider_id' });
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('two tickets for Mind Enterprises at Brooklyn Steel: general admission, a show, never a game or "Section General Admission, Row GA"', async () => {
    const c = new Concierge({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
    const r = (await c.ingestInbound(inbound({ text: '2 tickets to Mind Enterprises at Brooklyn Steel on October 10', from: 'steel@customer.example', subject: '', receivedAt: now }))) as { requestId: string };
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
    expect(req!.eventId).toBe(SHOW);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    const recs = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    const text = [...sends, ...recs].map((x) => x.bodyText).join('\n----\n');
    const html = [...sends, ...recs].map((x) => x.bodyHtml ?? '').join('\n');
    expect(text).toContain('That’s the lowest listing I can see for two tickets: general admission tickets');
    expect(text).toContain('Price lead · still needs checking\nGeneral admission\n');
    expect(text).not.toMatch(/I’d buy|cheapest available/);
    expect(text).toMatch(/for this show/);
    for (const body of [text, html]) expect(body).not.toMatch(/\bgames?\b|Section General Admission|Row GA/);
  });

  it('the words, for each kind of event', () => {
    expect(eventNounFor('nhl')).toBe('game');
    expect(eventNounFor('concert')).toBe('show');
    expect(eventNounFor('comedy')).toBe('show');
    expect(eventNounFor(null)).toBe('show');
    expect(seatPhrase('General Admission', 'GA')).toBe('general admission');
    expect(seatPhrase('GA Floor', null)).toBe('general admission floor');
    expect(seatPhrase('214', '10')).toBe('Section 214, Row 10');
    expect(seatPhrase('Gallery', null)).toBe('Section Gallery');
  });
});
