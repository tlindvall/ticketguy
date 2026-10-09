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

/**
 * Live, Oct 9 2026: after the Notre Dame vs Miami seats were sent, "Okay so tickets seem to be trending upwards. Do
 * you think there could be a drop in the prices nearer the game or what do you see historically?" got the game's
 * name, venue, date, party and budget again, a buy-or-wait paragraph and the same seat card. A question in the
 * thread about the game we already settled gets its answer, not the brief again.
 */
const KEY = 'fa'.repeat(32);
const H = 3_600_000;

describe('a follow-up question gets its answer, not the brief again', () => {
  let h: DbHandle;
  const now = FIXTURE_NOW;
  const ARENA = '10000000-0000-4000-8000-0000000010a9';
  const TEAM = '20000000-0000-4000-8000-0000000010a9';
  const GAME = '30000000-0000-4000-8000-0000000010a9';
  // A second team and game with past games' prices on file (SeatData history), so the history answer has something to say.
  const TEAM2 = '20000000-0000-4000-8000-0000000010b9';
  const GAME2 = '30000000-0000-4000-8000-0000000010b9';
  // Pair prices by hours before now: $700 three days ago, $650 a day ago, $708 now ("gone both ways").
  const pair = (ago: number) => (ago >= 72 ? 708 : ago >= 24 ? 708 - ((72 - ago) / 48) * 58 : 650 + ((24 - ago) / 24) * 58);
  const stats = () =>
    Array.from({ length: 49 }, (_, i) => {
      const ago = 96 - i * 2;
      const p = pair(ago);
      return { timestamp: new Date(now.getTime() - ago * H).toISOString(), total_listings_all: 600, total_listings_active: 400, listing_fill_rate: 0.6, avg_price: 900, median_price: 850, get_in: p - 20, get_in_qty2plus: p, zones: [] };
    });
  const listings = [
    { active: true, listing_id: 201, source: 'sh', price: 707.81, quantity: 2, section: '119', row: '26' },
    { active: true, listing_id: 202, source: 'vs', price: 760, quantity: 4, section: '120', row: '12' },
  ];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      const tm = url.searchParams.get('tm_event_id');
      return json({ data: tm ? [{ event_id: Number(tm.slice(4)), tm_event_id: tm, event_name: 'Irish vs Hurricanes', event_date: '2026-11-07', venue_name: 'Irish Stadium', venue_city: 'Notre Dame', venue_state: 'IN' }] : [], has_more: false, next_cursor: null });
    }
    if (/\/stats$/.test(url.pathname)) return json({ event_id: 9100, data: stats(), has_more: false, next_cursor: null });
    if (/\/sales$/.test(url.pathname)) return json({ data: [], has_more: false, next_cursor: null });
    if (url.pathname === '/api/v0.1.1/listings/get') return json({ has_refreshed: 1, last_refresh_timestamp: Math.floor((now.getTime() - 30 * 60_000) / 1000), listings });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const concierge = () => new Concierge({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });

  /** Each turn's new emails, in a thread when `first` is given. */
  const turn = async (text: string, from: string, first: ReturnType<typeof inbound> | null) => {
    const c = concierge();
    const seen = new Set([...(await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((x) => x.id), ...(await h.db.select({ id: t.recommendations.id }).from(t.recommendations)).map((x) => x.id)]);
    const m = inbound({ text, from, subject: first ? 'Re: Irish' : 'Irish', receivedAt: now, ...(first ? { inReplyTo: first.rfcMessageId, references: first.rfcMessageId } : {}) });
    const r = (await c.ingestInbound(m)) as { requestId: string };
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
    const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))).filter((s) => !seen.has(s.id));
    const recs = (await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))).filter((s) => !seen.has(s.id));
    if (process.env.PRINT_HTML) for (const [i, x] of [...sends, ...recs].entries()) (await import('node:fs')).writeFileSync(`${process.env.PRINT_HTML}/follow-up-${from.split('@')[0]}-${i}.html`, x.bodyHtml ?? '');
    return { m, text: [...sends.map((s) => s.bodyText), ...recs.map((x) => x.bodyText)].join('\n----\n') };
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Irish Stadium', city: 'Notre Dame', state: 'IN', country: 'US', timezone: 'America/Indiana/Indianapolis' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Irish Testers', slug: 'irish-testers-fa', aliases: ['Irish Testers'], league: 'NCAA', homeVenueId: ARENA });
    await h.db.insert(t.events).values({ id: GAME, name: 'Irish Testers vs. Hurricane Testers', category: 'nfl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-11-07T17:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME, sourceId: 'ticketmaster', sourceEventId: 'TMFA9100', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMFA9100', role: 'discovery', confidence: 'provider_id' });
    await h.db.insert(t.entities).values({ id: TEAM2, kind: 'team', name: 'Gold Testers', slug: 'gold-testers-fa', aliases: ['Gold Testers'], league: 'NCAA', homeVenueId: ARENA });
    await h.db.insert(t.events).values({ id: GAME2, name: 'Gold Testers vs. Storm Testers', category: 'nfl', venueId: ARENA, primaryEntityId: TEAM2, isHome: true, localStartAt: new Date('2026-11-07T17:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME2, sourceId: 'ticketmaster', sourceEventId: 'TMFA9200', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMFA9200', role: 'discovery', confidence: 'provider_id' });
    // Six past home games: the cheapest pair at this point (about 46 days out) against the final day. Four fell
    // ($700 → $560), one rose ($700 → $800), one held.
    const lead = Math.round((new Date('2026-11-07T17:00:00Z').getTime() - now.getTime()) / 60_000);
    const finals = [56000, 56000, 56000, 56000, 80000, 70500];
    const history = finals.flatMap((end, i) => {
      const start = new Date(Date.UTC(2025, 8, 6 + i * 14, 17));
      const at = (leadMin: number, price: number) => ({ datasetId: SEATDATA_DATASET_ID, providerEventId: `past-${i}`, entityId: TEAM2, venueId: ARENA, eventName: 'Gold Testers vs. Past', eventStartAt: start, basketKey: `provider:past-${i}:pair`, quantity: 2, seatZone: null, observedAt: new Date(start.getTime() - leadMin * 60_000), leadTimeMinutes: leadMin, priceCents: price });
      return [at(lead, 70000), at(6 * 60, end)];
    });
    await h.db.insert(t.marketHistory).values(history);
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('"could there be a drop nearer the game, what do you see historically?": the answer, no header, no card', async () => {
    const from = 'irish@customer.example';
    const first = await turn('2 tickets to Irish Testers vs Hurricane Testers on Nov 7, up to $1,500 total', from, null);
    expect(first.text).toContain('Section 119 · Row 26');
    // Sent to them (auto-approve does this live).
    await h.db.update(t.recommendations).set({ reviewStatus: 'sent' });
    const next = await turn('Okay so tickets seem to be trending upwards. Do you think there could be a drop in the prices nearer the game or what do you see historically?', from, first.m);
    // Not the brief again: the game, its venue and date, the party, the budget, the seat card.
    expect(next.text).not.toContain('Irish Testers vs. Hurricane Testers');
    expect(next.text).not.toMatch(/Irish Stadium|Saturday, November 7|up to \$1,500/);
    expect(next.text).not.toMatch(/Price lead · still needs checking|Section 119 · Row 26/);
    // The answer: what the prices have done, and that there's no history to say what happens nearer the game.
    expect(next.text).toMatch(/\$708(\.\d\d)? a ticket/);
    expect(next.text).toContain('I wouldn’t count on a drop. Listed resale prices for two or more tickets are at $708 a ticket');
    expect(next.text).toContain('I don’t have prices from past games like this one at the same point before the game, so I can’t tell you whether they usually drop closer to the day.');
    // Said once: not again under the seats as the over-budget line.
    expect(next.text.match(/up from \$650 a day ago/g)).toHaveLength(1);
    expect(next.text).toContain('Those figures are StubHub and Vivid Seats resale prices before fees.');
  });

  it('a plain "buy now or wait?" in the thread: the answer, without a history line nobody asked for', async () => {
    const from = 'irish2@customer.example';
    const first = await turn('2 tickets to Irish Testers vs Hurricane Testers on Nov 7, up to $1,500 total', from, null);
    await h.db.update(t.recommendations).set({ reviewStatus: 'sent' });
    const next = await turn('Should I buy now or wait?', from, first.m);
    expect(next.text).not.toMatch(/Irish Stadium|Price lead · still needs checking/);
    expect(next.text).toContain('I’d buy rather than wait');
    expect(next.text).not.toContain('past games');
  });

  it('the first answer still carries the game and the seats', async () => {
    const first = await turn('2 tickets to Irish Testers vs Hurricane Testers on Nov 7, up to $1,500 total. Should I buy now or wait?', 'irish3@customer.example', null);
    expect(first.text).toMatch(/Irish Testers vs\. Hurricane Testers/);
    expect(first.text).toContain('Section 119 · Row 26');
  });

  it('with past games on file, "what do you see historically?" is answered from them', async () => {
    const from = 'gold@customer.example';
    const first = await turn('2 tickets to Gold Testers vs Storm Testers on Nov 7, up to $1,500 total', from, null);
    await h.db.update(t.recommendations).set({ reviewStatus: 'sent' });
    const next = await turn('Do you think there could be a drop in the prices nearer the game or what do you see historically?', from, first.m);
    expect(first.text).toContain('Section 119 · Row 26');
    expect(next.text).toContain('A late drop is possible.');
    expect(next.text).toContain('Late drops happened in 4 of 6 previous games here we tracked. That’s the cheapest listed pair across the venue, not these seats, so it’s a reason to keep watching, not a promise they’ll get cheaper.');
    expect(next.text).not.toContain('I don’t have prices from past games');
  });
});
