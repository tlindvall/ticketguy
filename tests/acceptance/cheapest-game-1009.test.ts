import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge, acknowledgedFacts, asksCheapestGame } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { MarketTracker, storeSeriesPoints } from '@/lib/market/tracker';
import { dateWindowFor } from '@/lib/domain/dates';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Live, Oct 9 2026: "What upcoming new york rangers game would be good to take my son to with the lowest prices.
 * Before christmas." was answered as an acknowledgement ("Of the twelve ... home games before Christmas, Sun, Oct 11 vs.
 * Vancouver Canucks is the only one I have current prices for") and then a buy-or-wait brief about that one game. Only
 * one of twelve had a price because an untracked game was never priced. The answer is one email that ranks the games
 * on price, with every game priced through the tracker, and the customer picks; the pick goes on as an ordinary request.
 */
const now = FIXTURE_NOW; // Sep 22, 2026
const KEY = 'c9'.repeat(32);
const ARENA = '10000000-0000-4000-8000-0000000000d9';
const TEAM = '20000000-0000-4000-8000-0000000000d9';
// Each home game, its SeatData price a ticket for two (null: SeatData has no price for it), and one after Christmas.
const games = [
  { day: '2026-10-11', vs: 'Vancouver Canucks', cents: 12000, stored: true },
  { day: '2026-11-03', vs: 'Ottawa Senators', cents: 7400, stored: false },
  { day: '2026-11-20', vs: 'Utah Mammoth', cents: 8100, stored: false },
  { day: '2026-12-05', vs: 'Boston Bruins', cents: null, stored: false },
  { day: '2026-12-12', vs: 'Detroit Red Wings', cents: 9500, stored: false },
  { day: '2026-12-28', vs: 'Seattle Kraken', cents: 4000, stored: false },
].map((g, i) => ({ ...g, id: `30000000-0000-4000-8000-0000000000${(0xd0 + i).toString(16)}`, provider: String(9100 + i) }));

describe('"which game has the lowest prices?" is answered by ranking the games on price', () => {
  let h: DbHandle;
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    calls.push(url.pathname + (url.search ? `?${[...url.searchParams.keys()].join(',')}` : ''));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      const g = games.find((x) => `TMCG${x.provider}` === url.searchParams.get('tm_event_id'));
      return json({ data: g ? [{ event_id: Number(g.provider), tm_event_id: `TMCG${g.provider}`, event_name: `Metro Rangers vs. ${g.vs}`, event_date: g.day, venue_name: 'Garden Arena', venue_city: 'New York', venue_state: 'NY' }] : [], has_more: false, next_cursor: null });
    }
    const st = url.pathname.match(/^\/api\/v1\/events\/(\d+)\/stats$/);
    if (st) {
      const g = games.find((x) => x.provider === st[1]);
      // One snapshot an hour ago: the "2 or more" price is what a pair compares on.
      const at = new Date(now.getTime() - 60 * 60_000).toISOString();
      return json({ event_id: Number(st[1]), data: g?.cents ? [{ timestamp: at, total_listings_all: 300, total_listings_active: 200, listing_fill_rate: 0.6, avg_price: 200, median_price: 180, get_in: g.cents / 100 - 10, get_in_qty2plus: g.cents / 100, zones: [] }] : [], has_more: false, next_cursor: null });
    }
    if (/\/sales$/.test(url.pathname)) return json({ data: [], has_more: false, next_cursor: null });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const env = (over: Record<string, string> = {}) => testEnv({ SEATDATA_API_KEY: KEY, ...over });
  const concierge = (over: Record<string, string> = {}) => new Concierge({ db: h.db, env: env(over), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null, marketFetch: fetchImpl });
  const ask = async (text: string, from: string, over: Record<string, string> = {}, replyTo: string | null = null) => {
    const c = concierge(over);
    const first = inbound({ text, from, subject: replyTo ? 'Re: Rangers' : 'Rangers', receivedAt: now, inReplyTo: replyTo, references: replyTo });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    const research: string[] = [];
    for (let j = 0; j < 6; j++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(now.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') research.push(p.requestId!);
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return { req: req!, sends, research, emails: sends.map((s) => s.bodyText).join('\n----\n'), rfcMessageId: first.rfcMessageId! };
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Garden Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Rangers', slug: 'metro-rangers-cg', aliases: ['Metro Rangers'], league: 'NHL', homeVenueId: ARENA });
    for (const g of games) {
      const start = new Date(`${g.day}T23:00:00Z`);
      await h.db.insert(t.events).values({ id: g.id, name: `Metro Rangers vs. ${g.vs}`, category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: start, status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
      await h.db.insert(t.eventSourceMappings).values({ eventId: g.id, sourceId: 'ticketmaster', sourceEventId: `TMCG${g.provider}`, authoritativeUrl: `https://www.ticketmaster.com/x/event/TMCG${g.provider}`, role: 'discovery', confidence: 'provider_id' });
      // One game already priced from an earlier customer's tracking: read from the stored series, no provider call.
      if (g.stored && g.cents !== null) {
        const at = new Date(now.getTime() - 60 * 60_000);
        await storeSeriesPoints(h.db, { id: g.id, localStartAt: start }, [{ basis: 'pair', zone: null, observedAt: at, providerAsOf: at, retrievedAt: at, priceCents: g.cents, medianCents: null, activeListings: 30 }]);
      }
    }
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('one email: the cheapest game before Christmas first, the rest ranked, the unpriced one named, then the pick is an ordinary request', async () => {
    const from = 'dad@customer.example';
    calls.length = 0;
    const r = await ask('What upcoming metro rangers game would be good to take my son to with the lowest prices. Before christmas. 2 tickets', from);
    // The deliverable, not an acknowledgement and a brief: verdict, the ranked list, what isn't priced, one next action.
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0]!.messageClass).toBe('clarification');
    expect(r.sends[0]!.subject).toBe('Re: Rangers');
    expect(r.emails).toContain('Cheapest before Christmas: Tue, Nov 3 vs. Ottawa Senators, from $74 a ticket before fees for two.');
    const list = r.emails.slice(r.emails.indexOf('• Tue, Nov 3'));
    expect(list.indexOf('• Tue, Nov 3: Metro Rangers vs. Ottawa Senators at Garden Arena, from $74 a ticket before fees')).toBeLessThan(list.indexOf('• Fri, Nov 20: Metro Rangers vs. Utah Mammoth at Garden Arena, from $81 a ticket before fees'));
    expect(list.indexOf('• Fri, Nov 20')).toBeLessThan(list.indexOf('• Sat, Dec 12: Metro Rangers vs. Detroit Red Wings at Garden Arena, from $95 a ticket before fees'));
    expect(list.indexOf('• Sat, Dec 12')).toBeLessThan(list.indexOf('• Sun, Oct 11: Metro Rangers vs. Vancouver Canucks at Garden Arena, from $120 a ticket before fees'));
    expect(r.emails).toContain('I don’t have prices yet for one more (Sat, Dec 5 vs. Boston Bruins); I’ve started tracking them.');
    expect(r.emails).toContain('Reply with the date and I’ll find seats for two.');
    // Never the earlier game as the answer, never the cheaper game after Christmas, never a trend brief or an ack.
    expect(r.emails).not.toMatch(/already looked at|Seattle Kraken|whether resale is cheaper|I'll look at how the tickets are trading|buy rather than wait|Got it/);
    expect(r.emails).not.toMatch(/[–—]/);
    // The request is left as a browse leaves it: the list remembered, no game settled, no research run.
    expect(r.req.eventId).toBeNull();
    expect(r.req.state).toBe('needs_clarification');
    expect(r.req.browseShown).toEqual([games[1]!.id, games[2]!.id, games[4]!.id, games[0]!.id]);
    expect(r.research).toEqual([]);
    expect(await h.db.select().from(t.researchRuns).where(eq(t.researchRuns.requestId, r.req.id))).toHaveLength(0);
    // Every game was priced: the stored one from its series, the others through the tracker (match, poll), none from a
    // comparison read; the game after Christmas was never touched.
    const [aud] = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'request.games_compared'), eq(t.auditLog.entityId, r.req.id)));
    expect(aud!.diff).toMatchObject({ quantity: 2, basis: 'pair', display: true, refreshes: 4 });
    expect((aud!.diff as { games: Array<{ eventId: string; cents: number | null; refresh: string | null }> }).games).toEqual([
      { eventId: games[0]!.id, cents: 12000, refresh: null },
      { eventId: games[1]!.id, cents: 7400, refresh: 'refreshed' },
      { eventId: games[2]!.id, cents: 8100, refresh: 'refreshed' },
      { eventId: games[3]!.id, cents: null, refresh: 'refreshed' },
      { eventId: games[4]!.id, cents: 9500, refresh: 'refreshed' },
    ]);
    expect(calls.filter((c) => c.startsWith('/api/v1/events/search?tm_event_id'))).toHaveLength(4);
    expect(calls.filter((c) => /\/stats/.test(c))).toHaveLength(4);
    expect(calls.some((c) => c.includes('listings'))).toBe(false);
    // The refreshed games stay tracked, so the hourly pass keeps them priced for the next customer.
    const tracked = await h.db.select().from(t.trackedEvents).where(eq(t.trackedEvents.provider, 'seatdata'));
    expect(tracked.filter((x) => x.state === 'active').map((x) => x.eventId).sort()).toEqual([games[1]!.id, games[2]!.id, games[3]!.id, games[4]!.id].sort());
    expect(tracked.every((x) => x.reasons.includes('request'))).toBe(true);
    // Still a valid reason to keep polling with no event settled: the request lists the game it is choosing from.
    const tracker = new MarketTracker({ db: h.db, env: env({ SERVICE_POLICY_MODE: 'enforce' }), now: () => now, fetchImpl });
    expect(await tracker.validReasons(tracked.find((x) => x.eventId === games[1]!.id)!)).toContain('request');

    // The pick: the date alone resolves to that game and goes on to research as an ordinary request.
    const picked = await ask('Nov 3, 2 tickets', from, {}, r.rfcMessageId);
    expect(picked.req.id).toBe(r.req.id);
    expect(picked.req.eventId).toBe(games[1]!.id);
    expect(picked.research).toEqual([r.req.id]);
    expect(picked.sends.filter((s) => s.bodyText.includes('Cheapest before Christmas'))).toHaveLength(1);
  });

  it('the daily allowance stops the refreshing, and the games left unpriced are said, never guessed', async () => {
    // Fresh prices from the first test are reused; only the Boston game, untracked again, is unpriced, and the allowance
    // (one call a day here, against the four already spent) is gone: it is enrolled, never read.
    await h.db.delete(t.trackedEvents).where(eq(t.trackedEvents.eventId, games[3]!.id));
    calls.length = 0;
    const r = await ask('cheapest metro rangers game before christmas? 2 tickets', 'budget@customer.example', { SEATDATA_DAILY_CALL_LIMIT: '1' });
    expect(r.sends).toHaveLength(1);
    expect(r.emails).toContain('Cheapest before Christmas: Tue, Nov 3 vs. Ottawa Senators, from $74 a ticket before fees for two.');
    expect(r.emails).toContain('I don’t have prices yet for one more (Sat, Dec 5 vs. Boston Bruins); I’ve started tracking them.');
    expect(calls).toEqual([]);
    expect((await h.db.select().from(t.trackedEvents).where(eq(t.trackedEvents.eventId, games[3]!.id)))[0]).toMatchObject({ state: 'pending_match', reasons: ['request'] });
    const [aud] = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'request.games_compared'), eq(t.auditLog.entityId, r.req.id)));
    expect((aud!.diff as { games: Array<{ eventId: string; refresh: string | null }> }).games.find((g) => g.eventId === games[3]!.id)).toMatchObject({ refresh: 'budget' });
  });

  it('with no right to steer advice on market data, the games are listed in date order without prices and asked about', async () => {
    await h.db.update(t.marketDatasets).set({ approvedUses: ['tracking'] }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    try {
      const r = await ask('Which metro rangers game before christmas is cheapest? 2 tickets', 'noadvice@customer.example');
      expect(r.sends).toHaveLength(1);
      expect(r.emails).toContain('Five Metro Rangers home games before Christmas. I don’t have prices to compare them on yet, so here they are in date order.');
      expect(r.emails).not.toMatch(/\$\d|before fees|Cheapest/);
      expect(r.emails).toContain('Reply with the date and I’ll find seats for two.');
      expect(r.req.eventId).toBeNull();
      expect(r.research).toEqual([]);
    } finally {
      await h.db.update(t.marketDatasets).set({ approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'] }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    }
  });

  it('the words: a choice of game on price, not the cheapest seats for a game already named', () => {
    expect(asksCheapestGame('What upcoming new york rangers game would be good to take my son to with the lowest prices. Before christmas.')).toBe(true);
    expect(asksCheapestGame('cheapest knicks game in november?')).toBe(true);
    expect(asksCheapestGame('Which date has the best prices for 2?')).toBe(true);
    expect(asksCheapestGame('What are the cheapest seats for the Oct 11 game?')).toBe(false);
    expect(asksCheapestGame('Which section is best for kids?')).toBe(false);
    const e = { name: 'Metro Rangers vs. Ottawa Senators', category: 'nhl', localStartAt: new Date('2026-11-03T23:00:00Z') };
    expect(acknowledgedFacts(e, { name: 'Garden Arena', city: 'New York', timezone: 'America/New_York' }, ({ quantity: 2, resaleAsked: true, togetherRequired: null, budgetCents: null, budgetBasis: null, quotedPriceCents: null } as unknown as RequestExtraction), 'which rangers game has the lowest prices?')).toContain('You asked: which game has the lowest prices');
  });

  it('"before Christmas", "by Thanksgiving", "before Dec 15": from today up to then', () => {
    const at = new Date('2026-10-09T18:00:00Z');
    const w = (s: string) => dateWindowFor(s, at, 'America/New_York');
    expect(w('Before christmas.')).toEqual({ from: '2026-10-09', to: '2026-12-24' });
    expect(w('by thanksgiving')).toEqual({ from: '2026-10-09', to: '2026-11-26' });
    expect(w('before Dec 15')).toEqual({ from: '2026-10-09', to: '2026-12-14' });
    expect(w('by december 15th')).toEqual({ from: '2026-10-09', to: '2026-12-15' });
    expect(w('before November')).toEqual({ from: '2026-10-09', to: '2026-10-31' });
    expect(w('before the end of the year')).toEqual({ from: '2026-10-09', to: '2026-12-31' });
    // Asked after Christmas: next year's.
    expect(dateWindowFor('before christmas', new Date('2026-12-28T18:00:00Z'), 'America/New_York')).toEqual({ from: '2026-12-28', to: '2027-12-24' });
  });
});
