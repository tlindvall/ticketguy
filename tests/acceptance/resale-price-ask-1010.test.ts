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

/**
 * Live, Oct 10 2026: "How much are resale tickets selling for mind enterprises in Brooklyn tonight?" found the show
 * (Brooklyn Steel, 9 p.m.) and then answered with no price at all: a buy-or-wait line, "I can't see live resale
 * listings for this show yet" in the middle, and two questions. The resale feed didn't have the show.
 */
const KEY = 'ab'.repeat(32);
const now = new Date('2026-10-10T17:24:00Z');
const VENUE = '10000000-0000-4000-8000-0000000000e1';
const ACT = '20000000-0000-4000-8000-0000000000e1';
const SHOW = '30000000-0000-4000-8000-0000000000e1';

describe('"how much are resale tickets?" when the resale feed has no listings for the show', () => {
  let h: DbHandle;
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') return json({ data: [], has_more: false, next_cursor: null });
    if (url.pathname.includes('request')) return json({ ok: true });
    return json({ data: [], has_more: false, next_cursor: null });
  }) as unknown as typeof fetch;
  const ask = async (text: string) => {
    const c = new Concierge({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
    const r = (await c.ingestInbound(inbound({ text, from: 'tobias@customer.example', subject: '', receivedAt: now }))) as { requestId: string };
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
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    return [...sends.map((s) => s.bodyText), rec?.bodyText ?? ''].join('\n----\n');
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: VENUE, name: 'Brooklyn Steel', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: ACT, kind: 'artist', name: 'Mind Enterprises', slug: 'mind-enterprises', aliases: [], league: null, homeVenueId: null });
    await h.db.insert(t.events).values({ id: SHOW, name: 'Mind Enterprises (16 and Over)', category: 'concert', venueId: VENUE, primaryEntityId: ACT, isHome: null, localStartAt: new Date('2026-10-11T01:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), faceMinCents: 3500, faceMaxCents: 4500 });
    await h.db.insert(t.eventSourceMappings).values({ eventId: SHOW, sourceId: 'ticketmaster', sourceEventId: 'TMME1', authoritativeUrl: 'https://www.ticketmaster.com/mind-enterprises-brooklyn/event/TMME1', role: 'discovery', confidence: 'provider_id' });
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('says there are no resale prices first, with the official price and where to look, and asks nothing', async () => {
    const body = await ask('How much are resale tickets selling for mind enterprises in Brooklyn tonight?');
    expect(body).toContain('• You asked: what resale tickets are selling for');
    expect(body).not.toContain('whether resale is cheaper');
    expect(body).toContain('Mind Enterprises (16 and Over)\nBrooklyn Steel, Brooklyn · Tonight at 9 p.m. · 2 tickets\n\nI don’t have resale prices for Mind Enterprises: the StubHub and Vivid Seats listing data I use has no listings for this show right now. Ticketmaster’s own price is $35 to $45 a ticket before fees. You can see what resale sellers are asking with the links below, and if you send me a price you find, I’ll tell you how it compares.');
    expect(body).toContain('Search StubHub for this show: https://www.stubhub.com/search?q=Mind%20Enterprises\nSearch Vivid Seats for this show: https://www.vividseats.com/search?searchTerm=Mind%20Enterprises');
    // Said once, and no questionnaire under the answer.
    expect(body).not.toMatch(/I can’t see live resale listings|face value for this show|narrow it down|Found seats you like|most you’d pay/);
  });

  it('with no official sale to quote, it still answers and links the resale searches', async () => {
    await h.db.update(t.events).set({ saleStatus: 'offsale', faceMinCents: null, faceMaxCents: null }).where(eq(t.events.id, SHOW));
    const body = await ask('how much are tickets going for mind enterprises tonight in brooklyn?');
    expect(body).toContain('I don’t have resale prices for Mind Enterprises: the StubHub and Vivid Seats listing data I use has no listings for this show right now. You can see what resale sellers are asking with the links below');
    expect(body).toContain('Search Vivid Seats for this show:');
    expect(body).not.toMatch(/narrow it down|Found seats you like/);
  });
});
