import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';

/**
 * "Giants tickets Oct 11" was answered with "which Giants do you mean?" and "which city or venue?". For a
 * New York service the New York Giants are meant; the reply says so and asks nothing.
 */
describe('a shared nickname means the local team', () => {
  let h: DbHandle;
  const METLIFE = '10000000-0000-4000-8000-0000000000d1';
  const ORACLE = '10000000-0000-4000-8000-0000000000d2';
  const NYG = '20000000-0000-4000-8000-0000000000d1';
  const SFG = '20000000-0000-4000-8000-0000000000d2';
  const interpretAll = async (c: ReturnType<typeof makeConcierge>) => {
    for (let i = 0; i < 5; i++) {
      const work = (await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW })).filter((ev) => ev.eventType === 'request.interpret');
      if (!work.length) return;
      for (const ev of work) {
        const p = ev.payload as Record<string, string>;
        await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: METLIFE, name: 'MetLife Stadium', city: 'East Rutherford', state: 'NJ', country: 'US', timezone: 'America/New_York' },
      { id: ORACLE, name: 'Oracle Park', city: 'San Francisco', state: 'CA', country: 'US', timezone: 'America/Los_Angeles' },
    ]);
    await h.db.insert(t.entities).values([
      { id: NYG, kind: 'team', name: 'New York Giants', slug: 'new-york-giants', aliases: ['Giants'], league: 'NFL', homeVenueId: null },
      { id: SFG, kind: 'team', name: 'San Francisco Giants', slug: 'san-francisco-giants', aliases: ['Giants'], league: 'MLB', homeVenueId: null },
    ]);
    const game = (name: string, venueId: string, entity: string, at: string, category: string) => ({ name, category, venueId, primaryEntityId: entity, isHome: true, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
    await h.db.insert(t.events).values([
      game('New York Giants vs. Philadelphia Eagles', METLIFE, NYG, '2026-10-11T17:00:00Z', 'nfl'),
      game('San Francisco Giants vs. Los Angeles Dodgers', ORACLE, SFG, '2026-10-11T20:05:00Z', 'mlb'),
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('"Two Giants tickets Oct 11" goes to the New York Giants game, says so, and asks nothing', async () => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Two Giants tickets Oct 11', from: 'giants@customer.example', subject: 'Giants' }));
    await interpretAll(c);
    const requestId = (r as { requestId: string }).requestId;
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('researching');
    const [event] = await h.db.select().from(t.events).where(eq(t.events.id, req!.eventId!));
    expect(event!.name).toBe('New York Giants vs. Philadelphia Eagles');
    const body = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).map((s) => s.bodyText).join('\n');
    expect(body).toContain("I've gone with the New York Giants. Tell me if you meant a different team.");
    expect(body).not.toContain('which Giants');
    expect(body).not.toContain('Which city or venue');
  });
});
