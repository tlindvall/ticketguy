import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { acknowledgementLine, Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { eventConstraints, regionIn } from '@/lib/domain/event-constraints';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Live, Oct 4 2026: "when is the next metallica concert on the east coast?" got "Metallica tickets for the next game.
 * Got it." and "That's Metallica: Life Burns Faster at Sphere, Las Vegas, Thu, Oct 8, 8:30 PM PDT." The Las Vegas show
 * is real; "east coast" was no place at all to the resolver, so the next show anywhere won. A region is now a rule like
 * a venue: the answer is the next show inside it, or a plain "none there", never the next show anywhere.
 */
const NOW = new Date('2026-10-04T16:00:00Z');
const SPHERE = '10000000-0000-4000-8000-0000000001a1';
const MOHEGAN = '10000000-0000-4000-8000-0000000001a2';
const BAND = '20000000-0000-4000-8000-0000000001a1';
const BAND2 = '20000000-0000-4000-8000-0000000001a2';
const MOHEGAN_SHOW = '30000000-0000-4000-8000-0000000001a2';

class LiveFields implements Extractor {
  readonly name = 'fixture';
  private readonly rules = new FixtureExtractor();
  constructor(private readonly over: Partial<RequestExtraction>) {}
  async extract(input: Parameters<Extractor['extract']>[0]): Promise<RequestExtraction> {
    return { ...(await this.rules.extract(input)), ...this.over } as RequestExtraction;
  }
}

describe('a part of the country is a place', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: SPHERE, name: 'Sphere', city: 'Las Vegas', state: 'NV', country: 'US', timezone: 'America/Los_Angeles', latitude: 36.1209, longitude: -115.1621 },
      { id: MOHEGAN, name: 'Mohegan Sun Arena', city: 'Uncasville', state: 'CT', country: 'US', timezone: 'America/New_York', latitude: 41.4906, longitude: -72.0884 },
    ]);
    await h.db.insert(t.entities).values([
      { id: BAND, kind: 'artist', name: 'Metallica', slug: 'metallica', aliases: [] },
      { id: BAND2, kind: 'artist', name: 'Dead & Company', slug: 'dead-and-company', aliases: [] },
    ]);
    const show = (venueId: string, at: string, primaryEntityId = BAND, name = 'Metallica: Life Burns Faster') => ({ name, category: 'concert', venueId, primaryEntityId, localStartAt: new Date(at), status: 'scheduled' as const, verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' as const });
    await h.db.insert(t.events).values([
      show(SPHERE, '2026-10-09T03:30:00Z'),
      show(SPHERE, '2026-10-10T03:30:00Z'),
      { ...show(MOHEGAN, '2026-11-20T00:00:00Z', BAND, 'Metallica: M72 World Tour'), id: MOHEGAN_SHOW },
      show(SPHERE, '2026-10-16T03:30:00Z', BAND2, 'Dead & Company at Sphere'),
      show(SPHERE, '2026-10-23T03:30:00Z', BAND2, 'Dead & Company at Sphere'),
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  let seq = 0;
  const ask = async (text: string, over: Partial<RequestExtraction>) => {
    seq += 1;
    const c = new Concierge({ db: h.db, env: testEnv(), extractor: new LiveFields(over), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null });
    const r = (await c.ingestInbound(inbound({ text, from: `region${seq}@customer.example`, subject: '', receivedAt: NOW }))) as { requestId: string };
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return { req: req!, body: sends.map((s) => s.bodyText).join('\n----\n') };
  };
  const live: Partial<RequestExtraction> = { intent: 'new_search', budgetCents: null, budgetBasis: null, togetherRequired: false, performerOrTeam: 'Metallica', eventName: null, city: null, state: null, resolvedLocalDate: null, dateExpression: 'next', quantity: null, categoryHint: 'concert' };

  it('the live question: the next East Coast show, answered first, as a person says a date; never Las Vegas, never "game"', async () => {
    const r = await ask('when is the next metallica concert on the east coast?', live);
    expect(r.req.eventId).toBe(MOHEGAN_SHOW);
    expect(r.body).toContain('Hey,\n\nThe next one on the East Coast is Metallica: M72 World Tour at Mohegan Sun Arena in Uncasville, Thursday, November 19, at 7 p.m.');
    expect(r.body).not.toMatch(/Sphere|Las Vegas|game|Got it|PDT|EST/);
  });

  it('no date in the region: says so, with where the dates are, and never picks one', async () => {
    const r = await ask('when is the next dead and company show on the west coast?', { ...live, performerOrTeam: 'Dead & Company' });
    expect(r.req.eventId).toBeNull();
    expect(r.body).toContain('Hey,\n\nI don’t see any Dead & Company dates on the West Coast. The next two I have:\n• Sphere, Las Vegas: Thursday, October 15\n• Sphere, Las Vegas: Thursday, October 22');
    expect(r.body).toContain('Would one of those work? Tell me the city and how many tickets.');
    expect(r.body).not.toMatch(/doesn't fit|Got it/);
  });

  it('reads the regions people say, and not where they live or what they rule out', () => {
    expect(regionIn('when is the next metallica concert on the east coast?')?.states).toContain('CT');
    expect(regionIn('anything on the East-Coast')?.name).toBe('East Coast');
    expect(regionIn('any shows in New England this fall')?.name).toBe('New England');
    expect(regionIn('tri-state area please')?.states).toEqual(['NY', 'NJ', 'CT']);
    expect(regionIn('we live on the east coast but will travel')).toBeUndefined();
    expect(regionIn('not on the west coast')).toBeUndefined();
    expect(regionIn('flying southwest to see them')).toBeUndefined();
    expect(regionIn('two tickets in the South Bronx')).toBeUndefined();
    expect(regionIn('anywhere is fine')).toBeNull();
    // The latest message that names a place wins.
    const c = eventConstraints(['next metallica on the east coast?', 'anywhere is fine actually'], { receivedAt: NOW, timeZone: 'America/New_York', venues: [] });
    expect(c.region).toBeNull();
  });

  it('a concert is the next show, a team the next game', () => {
    expect(acknowledgementLine({ ...live, quantity: 2 } as RequestExtraction)).toBe('Two Metallica tickets for the next show. Got it.');
    expect(acknowledgementLine({ ...live, performerOrTeam: 'New York Rangers', categoryHint: 'nhl', quantity: 4 } as RequestExtraction)).toBe('Four New York Rangers tickets for the next game. Got it.');
  });
});
