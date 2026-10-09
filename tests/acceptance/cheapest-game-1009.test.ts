import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge, acknowledgedFacts, asksCheapestGame } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { storeSeriesPoints } from '@/lib/market/tracker';
import { dateWindowFor } from '@/lib/domain/dates';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Live, Oct 9 2026: "What upcoming new york rangers game would be good to take my son to with the lowest prices.
 * Before christmas." got "I've stayed with New York Rangers vs. Vancouver Canucks …, the game we already looked at",
 * and "You asked: whether resale is cheaper". It asked which game is cheapest; the answer compares the games on price.
 */
const now = FIXTURE_NOW; // Sep 22, 2026
const ARENA = '10000000-0000-4000-8000-0000000000d9';
const TEAM = '20000000-0000-4000-8000-0000000000d9';
// Each home game, the cheapest listed price a ticket for two (null: no price on file), and one after Christmas.
const games = [
  { day: '2026-10-11', vs: 'Vancouver Canucks', cents: 12000 },
  { day: '2026-11-03', vs: 'Ottawa Senators', cents: 7400 },
  { day: '2026-11-20', vs: 'Utah Mammoth', cents: 8100 },
  { day: '2026-12-05', vs: 'Boston Bruins', cents: null },
  { day: '2026-12-12', vs: 'Detroit Red Wings', cents: 9500 },
  { day: '2026-12-28', vs: 'Seattle Kraken', cents: 4000 },
].map((g, i) => ({ ...g, id: `30000000-0000-4000-8000-0000000000${(0xd0 + i).toString(16)}` }));

describe('"which game has the lowest prices?" is answered by comparing the games', () => {
  let h: DbHandle;
  const concierge = () => new Concierge({ db: h.db, env: testEnv({}), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: null });
  const ask = async (text: string, from: string) => {
    const c = concierge();
    const r = (await c.ingestInbound(inbound({ text, from, subject: 'Rangers', receivedAt: now }))) as { requestId: string };
    for (let j = 0; j < 6; j++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(now.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return { req: req!, emails: sends.map((s) => s.bodyText).join('\n----\n') };
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Garden Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Rangers', slug: 'metro-rangers-cg', aliases: ['Metro Rangers'], league: 'NHL', homeVenueId: ARENA });
    for (const g of games) {
      const start = new Date(`${g.day}T23:00:00Z`);
      await h.db.insert(t.events).values({ id: g.id, name: `Metro Rangers vs. ${g.vs}`, category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: start, status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
      if (g.cents !== null) {
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

  it('after an earlier game: the cheapest game before Christmas, the next two, and the one with no price said', async () => {
    const from = 'dad@customer.example';
    const first = await ask('2 tickets for the metro rangers game on Oct 11', from);
    expect(first.req.eventId).toBe(games[0]!.id);
    const r = await ask('What upcoming metro rangers game would be good to take my son to with the lowest prices. Before christmas. 2 tickets', from);
    expect(r.req.eventId).toBe(games[1]!.id);
    expect(r.emails).toContain('Of the four Metro Rangers home games before Christmas I can compare, Tue, Nov 3 vs. Ottawa Senators is the cheapest for two right now, from $74 a ticket before fees. Next cheapest: Fri, Nov 20 vs. Utah Mammoth ($81) and Sat, Dec 12 vs. Detroit Red Wings ($95). I don’t have current prices for one other. I’m looking at seats for Tue, Nov 3 now; tell me if you’d rather one of the others.');
    expect(r.emails).toContain('You asked: which game has the lowest prices');
    // Never the earlier game as the answer, never the cheaper game after Christmas, never "is resale cheaper".
    expect(r.emails).not.toMatch(/already looked at|Seattle Kraken|whether resale is cheaper/);
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
