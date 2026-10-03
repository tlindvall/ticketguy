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
  // Current listings: two can seat five (from $140), one more seats four; an inactive one is ignored.
  // SeatData dates the listings by its last refresh (`last_refresh_timestamp`, unix seconds): this one just refreshed.
  let groupListings = () => new Response(JSON.stringify({ has_refreshed: true, last_refresh_timestamp: Math.floor(now.getTime() / 1000), listings: [
    { active: true, listing_id: 1, price: 95, quantity: 2, quantity_start: 2, row: '10', section: '101', zone: 'Lower Bowl' },
    { active: true, listing_id: 2, price: 140, quantity: 6, quantity_start: 8, row: '4', section: '210', zone: 'Upper' },
    { active: true, listing_id: 6189203345, price: 155, quantity: 5, quantity_start: 5, row: '2', section: '112', zone: 'Lower Bowl' },
    { active: true, listing_id: 4, price: 120, quantity: 4, quantity_start: 4, row: '8', section: '215', zone: 'Upper' },
    { active: false, listing_id: 5, price: 60, quantity: 8, quantity_start: 8, row: '1', section: '220', zone: 'Upper' },
  ] }), { status: 200 });
  // When SeatData last refreshed the StubHub-id listings: just now unless a case says otherwise (LAUNCH-06).
  let shRefresh: () => Date | null = () => now;
  let liveStats: () => unknown[] = () => statsFor(new Date(now.getTime() - 96 * H), 96, 150, 110, 170, 130);
  const past = [1, 2, 3, 4, 5, 6].map((i) => ({ event_id: 900 + i, event_name: `Metro Testers vs. Team ${i}`, event_date: `2026-0${i < 4 ? 3 : 4}-${String(10 + i).padStart(2, '0')}`, event_time: '19:00:00', venue_name: 'Test Garden', venue_city: 'New York', venue_state: 'NY' })).concat([
    // R2-TIME-FOLD-01: 1:30 AM on Nov 2, 2025 happened twice in New York; with no offset its lead times can't be
    // measured, so this game is left out of history (and its stats never fetched).
    { event_id: 907, event_name: 'Metro Testers vs. Team 7', event_date: '2025-11-02', event_time: '01:30:00', venue_name: 'Test Garden', venue_city: 'New York', venue_state: 'NY' },
  ]);
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
    if (url.pathname === '/api/v0.1.1/listings/get' && url.searchParams.get('event_id') === '777') return groupListings();
    // A game SeatData has under its StubHub event id only (no Ticketmaster match): SDK 1.2 `event_id_sh`.
    if (url.pathname === '/api/v0.1.1/listings/get' && url.searchParams.get('event_id_sh') === '161999000') return json({ has_refreshed: 1, ...(shRefresh() ? { last_refresh_timestamp: Math.floor(shRefresh()!.getTime() / 1000) } : {}), listings: [
      { active: true, listing_id: 7001, source: 'sh', price: 88, quantity: 4, section: '224', row: '9' },
      { active: true, listing_id: 7002, source: 'sh', price: 61, quantity: 1, section: '311', row: '2' },
      { active: true, listing_id: 7003, source: 'sh', price: 74, quantity: 2, section: '312', row: '14' },
    ] });
    if (url.pathname === '/api/v1/events/777/sales') return json({ event_id: 777, data: [], has_more: false, next_cursor: null });
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
    expect(hist.some((r) => r.providerEventId === '907')).toBe(false);
    expect(calls.some((x) => x.startsWith('/api/v1/events/907/stats'))).toBe(false);
    // Staff-only until customer display is licensed: the claim exists, the email does not carry it.
    const [adv] = await h.db.select().from(t.adviceRuns).where(eq(t.adviceRuns.requestId, requestId));
    const claims = (adv!.packet as { claimRecords: Array<{ id: string; customerVisible: boolean; text: string }> }).claimRecords;
    const m = claims.find((x) => x.id === 'C_MARKET')!;
    expect(m.customerVisible).toBe(false);
    expect(m.text).toBe('Resale listings with two or more tickets currently start at $130 a ticket (listed price, before fees). That’s down from $160 three days ago. About 400 listings are up.');
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    expect(rec!.bodyText).not.toContain('Resale listings');
  });

  it('with customer display licensed: the reply names seats for the pair first, with what they are and are not', async () => {
    await setLicence('approved', ['tracking', 'benchmark', 'advice', 'customer_display']);
    const c = concierge();
    const requestId = await ask(c, '2 Testers tickets Oct 30 — is resale cheaper?', 'shown@customer.example');
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    // Seats for two, named from the listings we can read, are the answer (live Oct 3: seats, not questions). They are
    // the one price summary: no venue floor or budget sum from it under them.
    expect(rec!.bodyText).toContain('Test Garden, New York · Friday, October 30, at 7:30 p.m. · 2 tickets\n\nCheapest pair I can see: about $247 for both with fees.\n\n- Section 101, Row 10: $95 each, $190 for two before fees\n- Section 215, Row 8: $120 each, $240 for two before fees');
    expect(rec!.bodyText).toContain('- Fees: I’ve allowed 30%, so check the total at checkout.\n- Not checked yet: that they’re still for sale and sit together');
    // With no budget, the one next step is an offer to narrow it, on its own line, not a questionnaire.
    expect(rec!.bodyText).toContain('\n\nWant me to narrow it down? Tell me your budget, fees included, or where you’d like to sit.');
    expect(rec!.bodyText).not.toMatch(/things that would help|One thing that would help|When do you need tickets sorted by/);
    expect(rec!.bodyText).not.toContain('The resale market when I last checked');
    // The answer and each seat's place are bold; the prices are not (post-#55 writing review).
    expect(rec!.bodyHtml).toContain('<p style="margin:0 0 18px;"><strong>Cheapest pair I can see: about $247 for both with fees.</strong></p>');
    expect(rec!.bodyHtml).toContain('<li style="margin:0 0 8px;"><strong>Section 101, Row 10</strong>: $95 each, $190 for two before fees</li>');
    expect(rec!.bodyText).not.toContain('SeatData');
    expect(rec!.bodyText).not.toContain('I can’t see live resale listings');
    expect(rec!.bodyText).not.toMatch(/fair price|better deal|guarantee/);
    expect(rec!.bodyText).not.toContain('no need to rush');
    // No homework: seats were named, so it doesn't ask them to go and find some.
    expect(rec!.bodyText).not.toMatch(/Found seats you like\? Send me/);
  });

  // Live, Oct 1 2026: "I like the tickets I sent. are they worth it?" about a StubHub link got the market summary
  // and no answer. The question is answered first: what decides it, where the market sits for their number, and
  // the one thing (price and section) that gets a straight call.
  it('"are they worth it?" about a link we can’t open is answered as that question, first', async () => {
    const c = concierge();
    const first = inbound({ text: 'https://www.stubhub.com/metro-testers-new-york-tickets-10-30-2026/event/555/?quantity=2&listingId=777', from: 'worth@customer.example', subject: 'Testers' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    const run = async () => {
      for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now })).filter((e) => e.eventType === 'request.interpret')) {
        const p = ev.payload as Record<string, string>;
        await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    };
    await run();
    await c.research({ requestId: r.requestId, revision: 1 });
    await c.ingestInbound(inbound({ text: 'I like the tickets I sent. are they worth it?', from: 'worth@customer.example', subject: 'Re: Testers', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await run();
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    await c.research({ requestId: r.requestId, revision: req!.currentRevision });
    const recs = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    const body = recs.at(-1)!.bodyText;
    const lead = body.split('\n\n')[2]!;
    // A price first, then the one ask; no "I can't" lead (live Oct 2, Rangers).
    expect(lead).toBe('For two, the cheapest listings I can see start at $130 a ticket before fees (about $260 for two), from a recent read and easing. That’s where the market starts, not a verdict on yours. I couldn’t match the StubHub listing you picked in the listing data I can see, so reply with its price for two with fees and its section and row (a screenshot works), and I’ll tell you straight whether it’s worth it.');
    expect(body.match(/couldn’t match the StubHub listing/g)).toHaveLength(1);
    expect(body).not.toMatch(/I can’t open StubHub/);
    // One ask, the one that decides it: no budget question for judging an offer they've already picked (live R07).
    expect(body).not.toMatch(/most you’d want to pay|narrow it down/);
    expect(body).not.toContain('Going by the StubHub link you sent');
  });

  // A price under the cheapest resale listing used to read "a good price if it's genuine". It is a reason to
  // look closer, and a price well above it is not a bargain; neither is a verified offer.
  it('a price the customer asks about is set against the resale floor without calling it a deal', async () => {
    const c = concierge();
    const low = await ask(c, '2 Testers tickets Oct 30, is $100 a good deal?', 'quote-low@customer.example');
    await c.research({ requestId: low, revision: 1 });
    const [lowRec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, low));
    // The observed gap and its basis, never a band or a value label (remediation review §4).
    expect(lowRec!.bodyText).toContain('Against resale: It’s $30 a ticket below the cheapest listing I can see ($130 before fees). That’s unusual, so check the seats, the number of tickets and the fees before you pay.');
    expect(lowRec!.bodyText).not.toMatch(/good price|good deal/i);

    const high = await ask(c, '2 Testers tickets Oct 30, is $260 a good deal?', 'quote-high@customer.example');
    await c.research({ requestId: high, revision: 1 });
    const [highRec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, high));
    expect(highRec!.bodyText).toContain('It’s $130 a ticket above the cheapest listing I can see ($130 before fees).');
    expect(highRec!.bodyText).toContain('That cheapest listing could be any seat in the venue, so it doesn’t tell me what these seats are worth.');
    expect(highRec!.bodyText).not.toMatch(/fair|in line with the market|bargain/);
  });

  // Live: a reply that was only a StubHub link came back with market figures, a sentence naming SeatData, and
  // "send me the listing you are considering". It now says it went by their link, gives the read, and asks
  // for what the link can't tell us (the listing's price and section).
  it('a StubHub link gets an answer about that game, advice, and the questions the link can’t answer', async () => {
    const c = concierge();
    const link = 'https://www.stubhub.com/metro-testers-new-york-tickets-10-30-2026/event/555/?quantity=2&listingId=123456';
    const requestId = await ask(c, link, 'link-advice@customer.example');
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    const body = rec!.bodyText;
    // The event and the link they sent in one line at the top, then the answer.
    // What we couldn't see comes before the market, so the figures aren't read as that listing's (post-#54 L01).
    expect(body.startsWith('Hey,\n\nMetro Testers vs. Boston\nTest Garden, New York · Friday, October 30, at 7:30 p.m. · 2 tickets · from the StubHub link you sent\n\nFor two, the cheapest listings I can see start at $130 a ticket before fees (about $260 for two), from a recent read and easing. That’s where the market starts, not a verdict on yours. I couldn’t match the StubHub listing you picked in the listing data I can see, so reply with its price for two with fees and its section and row (a screenshot works), and I’ll tell you straight whether it’s a good price.\n\n')).toBe(true);
    expect(body).toContain('My read: ');
    expect(body).toContain('- Lowest asking price with two or more tickets, checked Sep 22, 11:00 AM EDT: $130 a ticket before fees');
    expect(body).not.toContain('fair price');
    // The ask is made once, in the lead; not again as a question at the end.
    expect(body.match(/couldn’t match the StubHub listing/g)).toHaveLength(1);
    expect(body).not.toMatch(/I can’t open StubHub|most you’d (?:want to )?pay/);
    expect(body).not.toMatch(/send me the (link|listing)/i);
  });

  // Live (Oct 1): a StubHub listing link got "I can't open StubHub listings myself" and the venue floor. Its
  // listing number is in the resale feed we're licensed for, so it's looked up there: the price, section and row
  // of the very listing they sent, said as a listed price before fees, never fetched from StubHub.
  it('a StubHub listing link is found in the resale feed by its listing number and answered as that listing', async () => {
    const c = concierge();
    const link = 'https://www.stubhub.com/metro-testers-new-york-tickets-10-30-2026/event/555/?quantity=2&listingId=6189203345';
    const requestId = await ask(c, link, 'link-match@customer.example');
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    const body = rec!.bodyText;
    expect(body).toContain('I found the listing you linked in the resale data I have, by its listing number: $155 a ticket before fees on StubHub. Fees are added at checkout, and I haven’t checked that the seats are still there.');
    expect(body).toContain('section 112, row 2');
    expect(body).not.toMatch(/can’t open StubHub|send a screenshot/);
    // The feed doesn't carry seat numbers, adjacency or delivery: said as gaps in the data, not in what they sent.
    expect(body).toContain('- The resale data for it doesn’t show when the tickets will be delivered.');
    // Cheaper listings for the pair, from the same read: one paid call, not two.
    expect(body).toContain('section 101, row 10 at $95 a ticket before fees (about $190 for both)');
    const [a] = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId, requestId), eq(t.auditLog.action, 'listing.link_matched')));
    expect(a).toBeTruthy();
  });

  // Final Human QA (Oct 2, live): this exact message and link went to a person after four failed research runs:
  // the call reservation bound a Date into raw SQL, which production's driver rejects (the test database now does
  // too). Both ways it ends now: the linked listing found by its number, or one screenshot asked for, never a crash.
  it('R1-HUMAN-01: the exact Rangers listing link and question are answered, matched or not, without a crash', async () => {
    const c = concierge();
    const text = 'Hey, looking at these for Tuesday. Is this a good deal for two or should I hold off?';
    const link = (id: string) => `https://www.stubhub.com/metro-testers-new-york-tickets-10-30-2026/event/161564036/?backUrl=%2Fnew-york-rangers-tickets%2Fgrouping%2F50025006&lt=40.671&lg=-73.894&quantity=2&listingId=${id}`;
    const unmatched = await ask(c, `${text}\n\n${link('14251313815')}`, 'r1-human-01a@customer.example');
    await c.research({ requestId: unmatched, revision: 1 });
    const [u] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, unmatched));
    expect(u!.bodyText).toContain('I couldn’t match the StubHub listing you picked in the listing data I can see, so reply with its price for two with fees and its section and row (a screenshot works), and I’ll tell you straight whether it’s worth it.');
    expect((await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId, unmatched), eq(t.auditLog.action, 'listing.link_unmatched')))).length).toBe(1);
    const matched = await ask(c, `${text}\n\n${link('6189203345')}`, 'r1-human-01b@customer.example');
    await c.research({ requestId: matched, revision: 1 });
    const [m] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, matched));
    expect(m!.bodyText).toContain('by its listing number: $155 a ticket before fees on StubHub');
    for (const id of [unmatched, matched]) expect((await h.db.select().from(t.requests).where(eq(t.requests.id, id)))[0]!.state).not.toBe('manual_attention');
  });

  it('R1-HUMAN-01: a resale read that fails costs the reply its market lines, never the reply', async () => {
    const broken = new Concierge({ db: h.db, env: env(), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch });
    const requestId = await ask(broken, '2 Testers tickets Oct 30, is $100 a good deal?', 'r1-human-01c@customer.example');
    await expect(broken.research({ requestId, revision: 1 })).resolves.toBeTruthy();
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    expect(rec!.bodyText).toContain('$100');
  });

  // Live Oct 2 (Rangers, after #89): the game wasn't matched to SeatData through Ticketmaster, so the reply was three
  // "I can't" lines. The link names StubHub's own event id, which SeatData reads directly: the reply now leads with
  // what two cost at that game, then makes one ask.
  it('an unmatched game is read by the link\'s StubHub event id: the price for their party first, then one ask', async () => {
    const OTHER = '30000000-0000-4000-8000-0000000000f9';
    await h.db.insert(t.events).values({ id: OTHER, name: 'Metro Testers vs. Chicago', category: 'nba', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-11-05T00:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' }).onConflictDoNothing();
    const c = concierge();
    const link = 'https://www.stubhub.com/metro-testers-new-york-tickets-11-4-2026/event/161999000/?quantity=2&listingId=55500011';
    const requestId = await ask(c, `Is this a good deal for two or should I hold off? ${link}`, 'sh-event@customer.example');
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    const body = rec!.bodyText;
    expect(body).toContain('For two together, StubHub listings for this game start at $74 a ticket before fees (about $148 for two), in section 312, row 14, when I checked just now. There are 2 listings with two or more tickets. I couldn’t match the StubHub listing you picked in the listing data I can see, so reply with its price for two with fees and its section and row (a screenshot works), and I’ll tell you straight whether it’s worth it.');
    expect(body).not.toMatch(/I can’t open StubHub|I can’t see live resale listings|most you’d (?:want to )?pay/);
    expect(calls.some((x) => x.startsWith('/api/v0.1.1/listings/get'))).toBe(true);
  });

  // LAUNCH-06: the read's age is SeatData's refresh time, never our fetch. A five-hour-old refresh fetched now is
  // said as five hours old; a read with no refresh time is said as undated, never "just now".
  it('the same link read from listings SeatData refreshed hours ago, or never dated, is said as that', async () => {
    const link = 'https://www.stubhub.com/metro-testers-new-york-tickets-11-4-2026/event/161999000/?quantity=2&listingId=55500011';
    const bodyFor = async (from: string) => {
      const c = concierge();
      const requestId = await ask(c, `Is this a good deal for two or should I hold off? ${link}`, from);
      await c.research({ requestId, revision: 1 });
      return (await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId)))[0]!.bodyText;
    };
    shRefresh = () => new Date(now.getTime() - 5 * H);
    const old = await bodyFor('sh-old@customer.example');
    expect(old).toContain('start at $74 a ticket before fees (about $148 for two), in section 312, row 14, as of about 5 hours ago, when the resale data was last refreshed.');
    expect(old).not.toContain('when I checked just now');
    shRefresh = () => null;
    const undated = await bodyFor('sh-undated@customer.example');
    expect(undated).toContain('in section 312, row 14, when I checked, though the resale data doesn’t say how recently it was refreshed.');
    expect(undated).not.toContain('just now');
    shRefresh = () => now;
  });

  it('five together read the listings: the cheapest listing with five or more and how many there are, no trend from one read', async () => {
    const c = concierge();
    calls.length = 0;
    const requestId = await ask(c, '5 Testers tickets Oct 30 together — is resale cheaper?', 'five@customer.example');
    await c.research({ requestId, revision: 1 });
    // The stats were fresh, but the group had never been read: one listings call, nothing else.
    expect(calls).toEqual(['/api/v0.1.1/listings/get?event_id']);
    const group = await h.db.select().from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, GAME), eq(t.marketSnapshots.basketKey, marketBasketKey(GAME, 'group:5', null))));
    expect(group).toHaveLength(1);
    expect(group[0]).toMatchObject({ quantity: 5, cheapestEligibleTotalCents: 14000, eligibleOptionCount: 2, feeBasis: 'listed_price' });
    const [adv] = await h.db.select().from(t.adviceRuns).where(eq(t.adviceRuns.requestId, requestId));
    const claims = (adv!.packet as { claimRecords: Array<{ id: string; kind: string; text: string; scope: { quantity: number } }> }).claimRecords;
    const m = claims.find((x) => x.id === 'C_MARKET')!;
    expect(m.kind).toBe('market_price');
    expect(m.scope.quantity).toBe(5);
    expect(m.text).toBe('Resale listings with 5 or more tickets currently start at $140 a ticket (listed price, before fees). About 2 listings have 5 or more tickets. Some are bigger blocks that may not split into exactly 5.');
    // One read is a price, not a trend: nothing here can say "wait".
    expect(adv!.decision).not.toBe('wait_and_recheck');
    // Asked again within the hour: the read is fresh, no second call.
    calls.length = 0;
    await c.research({ requestId, revision: 1 });
    expect(calls).toEqual([]);
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

  it('while testing, the numbers reach the test addresses with only tracking licensed, and the reply leads with them', async () => {
    await setLicence('approved', ['tracking', 'benchmark']);
    const c = new Concierge({ db: h.db, env: env({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'rangers5@customer.example' }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
    const requestId = await ask(c, '5 Testers tickets Oct 30 together, should I buy now or hold off?', 'rangers5@customer.example');
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    // Five together, named: the $140 block is six tickets and would leave the seller one, so it's said and passed over.
    expect(rec!.bodyText).toContain('Cheapest five together I can see: about $1,008 for all 5 with fees.\n\n- Section 112, Row 2: $155 each, $775 for five before fees');
    expect(rec!.bodyText).toContain('- Skipped: Section 210 at $140 each is 6 tickets, and sellers rarely leave a single seat.');
    expect(rec!.bodyText).not.toContain('I can’t see live resale listings');
    await setLicence('approved', ['tracking', 'benchmark', 'advice', 'customer_display']);
  });

  // "Look for better options": the listing they send is set against the market's current listings for their
  // group. Cheaper seats in their section or area are named as market data (before fees, no link, not their
  // seats); a listing in their own section and row is never offered back, since it may be the same seats.
  it('a pasted listing gets a recommendation first, its catches, and cheaper listings for the group', async () => {
    const read = { kind: 'ticket_listing' as const, sensitiveContent: false, seller: 'StubHub', eventName: 'Metro Testers vs. Boston', eventDate: '2026-10-30', venue: null, city: null, quantity: 4, priceText: '$210 each incl. fees', priceDollars: 210, priceBasis: 'per_ticket' as const, feeBasis: 'all_in' as const, totalDollars: null, section: '112', row: '5', seatNumbers: ['1', '2', '3', '4'], seatsTogether: true, restrictions: [], deliveryText: 'Mobile transfer', deliveryBy: '2026-10-29', includedBenefits: [], confidence: 'high' as const, unreadable: [] };
    const c = new Concierge({ db: h.db, env: env(), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl, listingReader: { name: 'fake', read: async () => read } });
    const requestId = await ask(c, '4 Testers tickets Oct 30. Found this: Sec 112 Row 5, seats 1-4, $210 each incl fees. Good?', 'alts@customer.example');
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    const body = rec!.bodyText;
    expect(body.startsWith('Hey,\n\nMetro Testers vs. Boston\nTest Garden, New York · Friday, October 30, at 7:30 p.m. · 4 tickets\n\nBefore you buy it, have a look at the cheaper listings below.')).toBe(true);
    expect(body).toContain('That’s 4 tickets, in section 112, row 5, seats 1, 2, 3 and 4, on StubHub, for $840 in total including fees, delivered by Oct 29.');
    expect(body).not.toContain('I can’t see what sellers are charging');
    expect(body).not.toMatch(/send me the listing/i);
    expect(body).toContain('Cheaper listings for 4 or more together that I can see: section 112, row 2 at $155 a ticket before fees (about $620 for all four), in your section (cheaper than yours only if its fees come to less than $220 in total). These are StubHub and Vivid Seats prices before fees, without a link, so search for them there. Your price includes fees (or may), so after fees these may not be cheaper: compare the checkout totals. They aren’t your seats, and I haven’t checked they’re still for sale.');
    // The cheaper listings already say what we can see; no "no verified alternative" line under them (launch E).
    expect(body).not.toContain('I haven’t found a verified alternative');
    // Recommendation first, the market figures after it, and nothing called a good deal.
    expect(body.indexOf('Before you buy it')).toBeLessThan(body.indexOf('Cheaper listings'));
    expect(body).not.toMatch(/good deal/i);
  });

  it('a failed listings read is logged and the stats poll still runs', async () => {
    const saved = groupListings;
    groupListings = () => new Response('{"error":"boom"}', { status: 500 });
    await h.db.update(t.trackedEvents).set({ nextPollAt: now }).where(eq(t.trackedEvents.eventId, GAME));
    const r = await tracker().run();
    expect(r.polled).toBe(1);
    const [err] = await h.db.select().from(t.marketFetches).where(and(eq(t.marketFetches.kind, 'listings'), eq(t.marketFetches.status, 'error')));
    expect(err).toBeTruthy();
    groupListings = saved;
  });

  it('stops at the daily call budget', async () => {
    await h.db.update(t.trackedEvents).set({ nextPollAt: now }).where(eq(t.trackedEvents.eventId, GAME));
    calls.length = 0;
    const r = await tracker({ SEATDATA_DAILY_CALL_LIMIT: '1' }).run();
    expect(r.polled).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
