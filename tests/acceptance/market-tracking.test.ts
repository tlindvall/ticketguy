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
    // The ticket brief (Oct 6): a price lead with its headline and reason, then the card with the event, the estimate
    // said as estimated and what isn't checked. The feed here names no marketplace, as live: both are searched.
    // What I'd do, why, the next action (Oct 9 review): falling, five weeks out, other pairs too, so another day.
    expect(rec!.bodyText).toContain('Hey,\n\nI’d give it another day.\n\nSection 101, Row 10 is about $247 for two tickets, including estimated fees, and two other options fit too. The checkout total and whether the seats are together haven’t been confirmed.\n\nComparable pairs have fallen 19% over three days. Waiting could improve the price, although this particular pair may go.\n\nHow prices are moving: falling\n3 days ago: $320\nYesterday: $280 (▼ $40)\nNow: $260 (▼ $20)\nThe cheapest listed pair, before fees, from StubHub and Vivid Seats.\n\nMetro Testers vs. Boston\nTest Garden, New York\nFriday, October 30 · tip-off 7:30 p.m.\n\nPrice lead · still needs checking\nSection 101 · Row 10\nAbout $247 for two · estimated fees included\nAbout $124 a ticket\n$190 before fees ($95 each). Includes a 30% fee allowance.\nSeats together: Not confirmed\nListed on: StubHub or Vivid Seats');
    expect(rec!.bodyText).toContain('Search StubHub for this game: https://www.stubhub.com/search?q=Metro%20Testers%20vs.%20Boston\nSearch Vivid Seats for this game: https://www.vividseats.com/search?searchTerm=Metro%20Testers%20vs.%20Boston\nFound it? Reply with the checkout screenshot');
    expect(rec!.bodyHtml).toContain('▼ Falling');
    expect(rec!.bodyText).toContain('Other price leads\nSection 215 · Row 8: $240 before fees ($120 each). $50 more before fees; not checked either\nSection 210 · Row 4: $280 before fees ($140 each).');
    expect(rec!.bodyText).toContain('Prices from StubHub and Vivid Seats listing data, refreshed in the last couple of hours.');
    expect(rec!.bodyText).not.toMatch(/I’d buy|Other leads shown|cheapest available|narrow it down/);
    // The card's links are on the card, once.
    expect(rec!.bodyText.match(/Search StubHub for this game/g)).toHaveLength(1);
    // The card: headline, neutral badge (lime is for checked offers), the estimate large, the search as an outlined
    // button, never a filled purchase button.
    expect(rec!.bodyHtml).toContain('>I’d give it another day.</h1>');
    expect(rec!.bodyHtml).toContain('background:#e9e3d8;');
    expect(rec!.bodyHtml).not.toContain('background:#d7f36b;');
    expect(rec!.bodyHtml).toContain('About $247 <span');
    // Not knowing which marketplace has the seats, neither gets a button: both are plain links.
    expect(rec!.bodyHtml).not.toContain('&nbsp;↗');
    // No artwork on a game: the generic concert art is for live music only.
    expect(rec!.bodyHtml).not.toContain('<img');
    // With no budget, the one next step is a specific offer, on its own line, not a questionnaire.
    expect(rec!.bodyText).toContain('\n\nIf you have a budget with fees, or a part of the venue you’d rather sit in, tell me and I’ll look again.');
    expect(rec!.bodyText).not.toMatch(/things that would help|One thing that would help|When do you need tickets sorted by/);
    expect(rec!.bodyText).not.toContain('The resale market when I last checked');
    expect(rec!.bodyText).not.toContain('SeatData');
    expect(rec!.bodyText).not.toContain('I can’t see live resale listings');
    expect(rec!.bodyText).not.toMatch(/fair price|better deal|guarantee/);
    expect(rec!.bodyText).not.toContain('no need to rush');
    // No homework: seats were named, so it doesn't ask them to go and find some.
    expect(rec!.bodyText).not.toMatch(/Found seats you like\? Send me/);
  });

  it('a known team gets its sport’s banner on the first brief of a conversation', async () => {
    await setLicence('approved', ['tracking', 'benchmark', 'advice', 'customer_display']);
    await h.db.insert(t.brandAssets).values({ kind: 'team', key: 'metro-testers', name: 'Metro Testers', shortName: 'MET', league: 'NBA', sport: 'basketball', primaryColor: '#1D428A', secondaryColor: '#FFC72C', source: 'team_file', rights: 'approved' }).onConflictDoNothing();
    // A sent email takes https images only, as live (APP_URL is the Render https address).
    const c = new Concierge({ db: h.db, env: { ...env(), APP_URL: 'https://ticketguy.example' }, extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
    const requestId = await ask(c, '2 Testers tickets Oct 30 — is resale cheaper?', 'banner@customer.example');
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    // Drawn by this app at an absolute URL, the customer's team first; the facts stay text under it.
    expect(rec!.bodyHtml).toMatch(/<img src="https:\/\/ticketguy\.example\/brief-art\/v1\/basketball\/metro-testers\/(?:_|[a-z0-9-]+)\.jpg" alt="" role="presentation"/);
    expect(rec!.bodyText).not.toContain('brief-art');
    await h.db.delete(t.brandAssets).where(eq(t.brandAssets.key, 'metro-testers'));
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
    // Cheaper listings for the pair, from the same read: one paid call, not two. The cheaper equivalent in their area
    // is the one I'd choose, compared for the pair on the same basis, with the search to find it (Oct 10 framework, B6a).
    expect(body).toContain('I’d choose this alternative. Your pair is $310 before fees; this comparable pair in section 101, row 10 is $190 before fees: $120 less, also in the Lower Bowl.');
    // Its price is the verdict's, not said again; the feed doesn't name its marketplace, so both searches (Oct 10 review).
    expect(body).toContain('The listing data doesn’t say whether it’s on StubHub or Vivid Seats, so look for section 101 on both. It isn’t your seats, and I haven’t checked it’s still for sale or that the seats are together.');
    expect(body).toContain('Search StubHub for section 101: https://www.stubhub.com/search?q=');
    expect(body).toContain('Search Vivid Seats for section 101: https://www.vividseats.com/search?searchTerm=');
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
    // Their buy-or-wait question leads; the brief's card follows it without naming the game a second time.
    expect(rec!.bodyText).toContain('Price lead · still needs checking\nSection 112 · Row 2\nAbout $1,008 for all five · estimated fees included\nAbout $202 a ticket\n$775 before fees ($155 each). Includes a 30% fee allowance.');
    expect(rec!.bodyText.match(/Metro Testers vs\. Boston/g)).toHaveLength(1);
    expect(rec!.bodyText).toContain('Why not cheaper: Section 210 at $140 each is 6 tickets, and sellers rarely leave a single seat.');
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
    // What I'd do, then the one comparison behind it, on a conservative basis: theirs includes fees, the listing's
    // doesn't (Oct 10 framework, B6a). Then what the listing is and isn't, and the search to find it.
    expect(body.startsWith('Hey,\n\nMetro Testers vs. Boston\nTest Garden, New York · Friday, October 30, at 7:30 p.m. · 4 tickets\n\nI’d choose this alternative. Your four tickets are $840 with fees; this comparable set of four in section 112, row 2 is $620 before fees, in the same section: cheaper than yours only if its fees come to less than $220 in total.')).toBe(true);
    expect(body).toContain('That’s 4 tickets, in section 112, row 5, seats 1, 2, 3 and 4, on StubHub, for $840 in total including fees, delivered by Oct 29.');
    expect(body).not.toContain('I can’t see what sellers are charging');
    expect(body).not.toMatch(/send me the listing/i);
    expect(body).toContain('The listing data doesn’t say whether it’s on StubHub or Vivid Seats, so look for section 112 on both. It isn’t your seats, and I haven’t checked it’s still for sale or that the seats are together.');
    expect(body).toContain('Search StubHub for section 112: https://www.stubhub.com/search?q=Metro%20Testers%20vs.%20Boston');
    expect(body).toContain('Search Vivid Seats for section 112: https://www.vividseats.com/search?searchTerm=Metro%20Testers%20vs.%20Boston');
    // The alternative already says what we can see; no "no verified alternative" line under it (launch E), and no
    // venue floor or trend read: the comparison is the reason, the market section isn't (B8).
    expect(body).not.toMatch(/I haven’t found a verified alternative|Cheaper listings for|Before you buy it|resale market when I last checked|My read:/);
    // Recommendation first, the listing's facts after it, and nothing called a good deal.
    expect(body.indexOf('I’d choose this alternative')).toBeLessThan(body.indexOf('That’s 4 tickets'));
    expect(body).not.toMatch(/good deal/i);
  });

  // Live Oct 3: "Are these tickets a good deal? Should I buy now or hold off?" with a Ticketmaster event link and no
  // count got "How many tickets…?" and "I don't have usable price history", without SeatData ever being read.
  it('an event link asked "good deal, buy now or hold off?" with no count is checked against the market for two', async () => {
    const c = concierge();
    const requestId = await ask(c, 'Are these tickets a good deal? Should I buy now or hold off?\n\nhttps://www.ticketmaster.com/metro-testers-vs-boston-new-york-new-york-10-30-2026/event/TMGAME1?refArtist=K8vZ9171o87&f_simplified_filter=true', 'evpage@customer.example');
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now })).filter((e) => e.eventType === 'research.requested')) {
      await c.research({ requestId, revision: Number((ev.payload as Record<string, string>).revision) });
      await markDispatched(h.db, ev.id, ev.leaseToken, now);
    }
    const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).map((x) => x.bodyText);
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    const all = [...sends, rec!.bodyText].join('\n');
    // The market was read for this request (the series is already fresh from the cases above, so no new call is needed).
    expect((await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId, requestId), eq(t.auditLog.action, 'market.trend_assessed')))).length).toBe(1);
    expect(all).toContain('I\'ve assumed two tickets. Just tell me if you need a different number.');
    // What the market says depends on the series the cases above left; that it's answered from it does not.
    expect(rec!.bodyText).toMatch(/On buy or wait: [^\n]*\$\d+ a ticket/);
    expect(rec!.bodyText).toContain('That link is the game’s page, not particular seats, so reply with the price for two with fees and the section and row of the ones you’re looking at (a screenshot works)');
    // The opponent in the link's words is not the city, and the event link is never "the listing you picked".
    expect(all).not.toMatch(/usable price history|How many tickets|isn’t playing in Boston|listing you picked/);
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
