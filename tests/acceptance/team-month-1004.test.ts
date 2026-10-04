import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Live, Oct 4 2026: "We want to see the knicks in new york in october. give me some good options!" got "New York Knicks
 * tickets in october. Got it. Which date are you looking at? Send a date or ticket link if you have one." The catalog
 * had their October games; with more than three, the reply asked for a date instead of naming them. It now lists the
 * games and asks which one and how many.
 */
const NOW = new Date('2026-10-04T17:23:00Z');
const PHILLY = '10000000-0000-4000-8000-0000000003a1';

class LiveFields implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  constructor(private readonly over: Partial<RequestExtraction>) {}
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    return { ...(await this.rules.extract(input)), ...this.over } as RequestExtraction;
  }
}

describe('a team and a month', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: PHILLY, name: 'Xfinity Mobile Arena', city: 'Philadelphia', state: 'PA', country: 'US', timezone: 'America/New_York', latitude: 39.9012, longitude: -75.172 });
    const game = (name: string, at: string, venueId: string = FX.venues.msg, subtype = 'regular_season') => ({ name, category: 'nba', subtype, venueId, primaryEntityId: FX.entities.knicks, localStartAt: new Date(at), status: 'scheduled' as const, verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' as const, isHome: venueId === FX.venues.msg });
    await h.db.insert(t.events).values([
      game('Preseason: New York Knicks v Washington Wizards', '2026-10-08T23:30:00Z', FX.venues.msg, 'preseason'),
      game('New York Knicks vs. Boston Celtics', '2026-10-21T23:30:00Z'),
      game('New York Knicks vs. Philadelphia 76ers', '2026-10-27T23:30:00Z', PHILLY),
      game('New York Knicks vs. Miami Heat', '2026-10-29T23:30:00Z'),
      game('New York Knicks vs. Chicago Bulls', '2026-11-02T00:00:00Z'),
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('the live request: the October games in New York, then which one and how many; never "Which date?"', async () => {
    const c = new Concierge({ db: h.db, env: testEnv(), extractor: new LiveFields({ intent: 'new_search', performerOrTeam: 'New York Knicks', eventName: null, city: 'New York', state: 'NY', dateExpression: 'in october', resolvedLocalDate: null, quantity: null, categoryHint: 'nba' }), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null });
    const r = (await c.ingestInbound(inbound({ text: 'We want to see the knicks in new york in october. give me some good options!', from: 'knicks@customer.example', subject: '', receivedAt: NOW }))) as { requestId: string };
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
    }
    const [send] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    const body = send!.bodyText;
    expect(body).toContain('Hey,\n\nHere are the New York Knicks games in New York in October:\n• Thursday, October 8, at 7:30 p.m.: vs. Washington Wizards (preseason)\n• Wednesday, October 21, at 7:30 p.m.: vs. Boston Celtics\n• Saturday, October 24, at 7:30 p.m.: vs. Fixture Opponent\n• Thursday, October 29, at 7:30 p.m.: vs. Miami Heat');
    expect(body).toContain('Which game would you like? I’ll look for the best seats for it.');
    expect(body).toMatch(/How many tickets/);
    expect(body).not.toMatch(/Which date are you looking at|76ers|Bulls|Got it/);
    expect(send!.bodyHtml).toContain('<li');
  });
});
