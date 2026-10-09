import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Live, Oct 8 2026: "I need 2 tickets to Norte Dane vs Miami on Nov 7th, 2026" was searched as typed and answered
 * "couldn't find a Norte Dane performance". A typo in a name we know is read as that name, said so, and a matchup is
 * a game, never a performance.
 */
const NOW = new Date('2026-10-08T22:38:00Z');
const STADIUM = '10000000-0000-4000-8000-000000001008';
const ND = '20000000-0000-4000-8000-000000001008';
const GAME = '30000000-0000-4000-8000-000000001008';

class Script implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  constructor(private readonly over: Partial<RequestExtraction>) {}
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    return { ...(await this.rules.extract(input)), ...this.over } as RequestExtraction;
  }
}

describe('"Norte Dane vs Miami": the name they meant, and a game', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: STADIUM, name: 'Hard Rock Stadium', city: 'Miami Gardens', state: 'FL', country: 'US', timezone: 'America/New_York' });
  });
  afterAll(async () => {
    await h.close();
  });
  const ask = async (from: string) => {
    // As the model read it on Oct 8: the typo kept, the matchup in eventName, no category.
    const c = new Concierge({ db: h.db, env: testEnv(), extractor: new Script({ intent: 'new_search', performerOrTeam: 'Norte Dane', eventName: 'Norte Dane vs Miami', quantity: 2, dateExpression: 'Nov 7th, 2026', resolvedLocalDate: '2026-11-07', city: null, state: null, categoryHint: null }), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null });
    const r = (await c.ingestInbound(inbound({ text: 'I need 2 tickets to Norte Dane vs Miami on Nov 7th, 2026', from, subject: 'Tickets', receivedAt: NOW }))) as { requestId: string };
    for (const ev of await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) })) {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return { req: req!, text: sends.map((s) => s.bodyText).join('\n----\n') };
  };

  it('not in the catalog yet: the team roster still reads it as Notre Dame, and it is a game, never a performance', async () => {
    const r = await ask('nd-1@customer.example');
    expect(r.text).toContain('I’ve read “Norte Dane” as Notre Dame Fighting Irish.');
    expect(r.text).not.toMatch(/performance|Norte Dane (?:game|tickets)/);
  });

  it('Notre Dame on file: read as Notre Dame, said so, and the game is found', async () => {
    await h.db.insert(t.entities).values({ id: ND, kind: 'team', name: 'Notre Dame Fighting Irish', slug: 'notre-dame-1008', aliases: ['Notre Dame'], league: 'NCAAF' });
    await h.db.insert(t.events).values({ id: GAME, name: 'Notre Dame Fighting Irish vs. Miami Hurricanes', category: 'ncaaf', venueId: STADIUM, primaryEntityId: ND, localStartAt: new Date('2026-11-08T00:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
    const r = await ask('nd-2@customer.example');
    expect(r.req.eventId).toBe(GAME);
    expect(r.text).toContain('I’ve read “Norte Dane” as Notre Dame Fighting Irish. Tell me if you meant someone else.');
    expect(r.text).not.toMatch(/Norte Dane (?:performance|game|tickets)/);
  });
});

describe('the no-results sentence for a matchup', () => {
  it('a team named in a matchup plays a game, even with no category and no catalog entry', async () => {
    const { noMatchNote } = await import('@/lib/intake/pipeline');
    const brief = { performerOrTeam: 'Norte Dane', eventName: 'Norte Dane vs Miami', resolvedLocalDate: '2026-11-07', dateExpression: null, city: null, state: null, categoryHint: null } as unknown as RequestExtraction;
    expect(noMatchNote('discovery_no_results', brief, null)).toBe("I searched Ticketmaster's listings and couldn't find a Norte Dane game on Sat, Nov 7. That's what I can search, not proof there isn't one, so I haven't looked at prices yet.");
    expect(noMatchNote('discovery_no_results', { ...brief, eventName: null, performerOrTeam: 'Phoebe Bridgers' } as RequestExtraction, null)).toContain('a Phoebe Bridgers performance');
  });
});
