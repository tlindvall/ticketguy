import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { prominenceTier } from '@/lib/domain/browse';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { storeSeriesPoints } from '@/lib/market/tracker';

/**
 * Live, Oct 9 2026: "My family is coming to New York next week. What sports games are on?" listed "St. John's Red Storm
 * Men's Basketball v. Drexel (Exhibition)" as pick three while Knicks and Yankees games were in the window, because the
 * picks were the first three by date. A sports browse now ranks the major leagues first, other seasons next, and
 * exhibitions last; nothing is dropped. A game whose price we already hold says it. (Devils, Rangers, Knicks and Yankees
 * in the live window; here the Devils are an Islanders game, since "New York" keeps the list to the city itself.)
 */
const now = FIXTURE_NOW; // Tue, Sep 22 2026
const GARDEN = '10000000-0000-4000-8000-0000000000e1';
const STADIUM = '10000000-0000-4000-8000-0000000000e2';
const ROCK = '10000000-0000-4000-8000-0000000000e3';
const GYM = '10000000-0000-4000-8000-0000000000e4';
const RANGERS_GAME = '30000000-0000-4000-8000-0000000000e1';

describe('a sports browse ranks the major leagues before an exhibition, and says a price it already holds', () => {
  let h: DbHandle;
  const interpretAll = async (c: ReturnType<typeof makeConcierge>) => {
    for (let i = 0; i < 5; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now });
      const work = leased.filter((ev) => ev.eventType === 'request.interpret');
      if (!work.length) return;
      for (const ev of work) {
        const p = ev.payload as Record<string, string>;
        await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    }
  };
  const lastSend = async (requestId: string) => (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).at(-1)!;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: GARDEN, name: 'Garden Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' },
      { id: STADIUM, name: 'Bronx Ballpark', city: 'Bronx', state: 'NY', country: 'US', timezone: 'America/New_York' },
      { id: ROCK, name: 'Rock Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' },
      { id: GYM, name: 'Carnesecca Court', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' },
    ]);
    const row = (id: string | null, name: string, category: string, venueId: string, at: string) => ({ ...(id ? { id } : {}), name, category, venueId, primaryEntityId: null, isHome: true, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
    // Next week (Sep 28 to Oct 4), the exhibition first by date, each game on its own day.
    await h.db.insert(t.events).values([
      row(null, "St. John's Red Storm Men's Basketball v. Drexel (Exhibition)", 'ncaa_regular', GYM, '2026-09-28T23:00:00Z'),
      row(null, 'New York Islanders vs. Philadelphia Flyers', 'nhl', ROCK, '2026-09-29T23:00:00Z'),
      row(RANGERS_GAME, 'New York Rangers vs. Boston Bruins', 'nhl', GARDEN, '2026-09-30T23:00:00Z'),
      row(null, 'New York Knicks vs. Boston Celtics', 'nba', GARDEN, '2026-10-01T23:30:00Z'),
      row(null, 'New York Yankees vs. Toronto Blue Jays', 'mlb', STADIUM, '2026-10-02T23:00:00Z'),
    ]);
    // A price already on file for the Rangers game, from a customer who asked about it yesterday.
    const at = new Date(now.getTime() - 3 * 3_600_000);
    await storeSeriesPoints(h.db, { id: RANGERS_GAME, localStartAt: new Date('2026-09-30T23:00:00Z') }, [{ basis: 'pair', zone: null, observedAt: at, providerAsOf: at, retrievedAt: at, priceCents: 9500, medianCents: null, activeListings: 40 }]);
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('the three picks are pro games; the exhibition comes only after "more"; the held price is said', async () => {
    const c = makeConcierge(h, { env: testEnv({}) });
    const first = inbound({ text: 'My family is coming to New York next week. What sports games are on?', from: 'family@customer.example', subject: 'NY trip' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await interpretAll(c);
    const one = (await lastSend(r.requestId)).bodyText;
    expect(one).toContain('Games in New York, Sep 28 to Oct 4. Here are my three picks:');
    expect(one).toContain('• Tue, Sep 29: New York Islanders vs. Philadelphia Flyers at Rock Arena.');
    expect(one).toContain('• Wed, Sep 30: New York Rangers vs. Boston Bruins at Garden Arena, from $95 a ticket before fees.');
    expect(one).toContain('• Thu, Oct 1: New York Knicks vs. Boston Celtics at Garden Arena.');
    expect(one).not.toMatch(/Drexel|Exhibition|Yankees/);
    expect(one).toMatch(/There are \d more in that window. Reply "more" to see them/);
    // No price was invented for the games we hold nothing on.
    expect(one.match(/before fees/g)).toHaveLength(1);
    expect(one).not.toMatch(/[\u2013\u2014]/);
    // The continuation (the seeded fixture games share the window): every other game comes before the exhibition,
    // which is on the last page, after the Yankees.
    const pages = [one];
    for (let i = 0; i < 4 && !/Drexel/.test(pages.at(-1)!); i++) {
      await c.ingestInbound(inbound({ text: 'more', from: 'family@customer.example', subject: 'Re: NY trip', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
      await interpretAll(c);
      pages.push((await lastSend(r.requestId)).bodyText);
    }
    const all = pages.join('\n====\n');
    expect(all).toContain('\u2022 Fri, Oct 2: New York Yankees vs. Toronto Blue Jays at Bronx Ballpark');
    expect(all).toContain("\u2022 Mon, Sep 28: St. John's Red Storm Men's Basketball v. Drexel (Exhibition) at Carnesecca Court");
    expect(all.indexOf('Yankees')).toBeLessThan(all.indexOf('Drexel'));
    expect(pages.at(-1)).toMatch(/Drexel/);
    expect(pages.at(-1)!.split('Drexel')[1] ?? '').not.toMatch(/\n\u2022 /);
  });

  it('prominence: the major leagues, then other seasons, then exhibitions, preseason and anything that is not a game', () => {
    expect(prominenceTier({ name: 'New York Knicks vs. Boston Celtics', category: 'nba' })).toBe(0);
    expect(prominenceTier({ name: 'New York City FC vs. Inter Miami CF', category: 'soccer' })).toBe(0);
    expect(prominenceTier({ name: 'Brooklyn Cyclones vs. Hudson Valley Renegades', category: 'minor_league' })).toBe(1);
    expect(prominenceTier({ name: "St. John's Red Storm Men's Basketball v. Seton Hall", category: 'ncaa_regular' })).toBe(1);
    expect(prominenceTier({ name: "St. John's Red Storm Men's Basketball v. Drexel (Exhibition)", category: 'ncaa_regular' })).toBe(2);
    expect(prominenceTier({ name: 'New York Giants vs. New York Jets (Preseason)', category: 'nfl' })).toBe(2);
    expect(prominenceTier({ name: 'New York Knicks Open Practice', category: 'nba' })).toBe(2);
    expect(prominenceTier({ name: 'USMNT vs. Mexico International Friendly', category: 'soccer' })).toBe(2);
  });
});
