import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW, FX } from '@/lib/fixtures';

/**
 * A customer's home is remembered with their email. "Rangers" is the New York Rangers for a New Yorker and the
 * Texas Rangers for someone in Dallas: from where they said they live, else from where what they asked about was.
 */
describe('where a customer is based is remembered', () => {
  let h: DbHandle;
  const MSG = FX.venues.msg;
  const GLOBE = '10000000-0000-4000-8000-0000000009a2';
  const AAC = '10000000-0000-4000-8000-0000000009a3';
  const ARENA = '10000000-0000-4000-8000-0000000009a4';
  const NYR = FX.entities.rangers;
  const TEX = '20000000-0000-4000-8000-0000000009a2';
  const DAL = '20000000-0000-4000-8000-0000000009a3';
  const NYK = FX.entities.knicks;
  const BAND = '20000000-0000-4000-8000-0000000009a5';

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
  const ask = async (c: ReturnType<typeof makeConcierge>, from: string, text: string, subject: string) => {
    const r = await c.ingestInbound(inbound({ text, from, subject }));
    await interpretAll(c);
    const requestId = (r as { requestId: string }).requestId;
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    const [event] = req!.eventId ? await h.db.select().from(t.events).where(eq(t.events.id, req!.eventId)) : [];
    const body = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).map((s) => s.bodyText).join('\n');
    return { event: event?.name ?? null, body };
  };

  beforeEach(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: GLOBE, name: 'Globe Life Field', city: 'Arlington', state: 'TX', country: 'US', timezone: 'America/Chicago' },
      { id: AAC, name: 'American Airlines Center', city: 'Dallas', state: 'TX', country: 'US', timezone: 'America/Chicago' },
      { id: ARENA, name: 'Crypto.com Arena', city: 'Los Angeles', state: 'CA', country: 'US', timezone: 'America/Los_Angeles' },
    ]);
    await h.db.insert(t.entities).values([
      { id: TEX, kind: 'team', name: 'Texas Rangers', slug: 'texas-rangers', aliases: ['Rangers'], league: 'MLB', homeVenueId: GLOBE },
      { id: DAL, kind: 'team', name: 'Dallas Mavericks', slug: 'dallas-mavericks', aliases: ['Mavericks', 'Mavs'], league: 'NBA', homeVenueId: AAC },
      { id: BAND, kind: 'artist', name: 'The Lumineers', slug: 'the-lumineers-1009', aliases: ['Lumineers'], league: null, homeVenueId: null },
    ]);
    const ev = (name: string, venueId: string, entity: string, at: string, category: string, isHome: boolean | null = true) => ({ name, category, venueId, primaryEntityId: entity, isHome, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });
    await h.db.insert(t.events).values([
      ev('New York Rangers vs. Boston Bruins', MSG, NYR, '2026-10-11T23:00:00Z', 'nhl'),
      ev('Texas Rangers vs. Houston Astros', GLOBE, TEX, '2026-10-11T19:05:00Z', 'mlb'),
      ev('Dallas Mavericks vs. Phoenix Suns', AAC, DAL, '2026-10-12T00:30:00Z', 'nba'),
      ev('New York Knicks vs. Boston Celtics', MSG, NYK, '2026-10-13T23:30:00Z', 'nba'),
      ev('The Lumineers', MSG, BAND, '2026-10-14T00:00:00Z', 'concert', null),
      ev('The Lumineers', ARENA, BAND, '2026-10-16T03:00:00Z', 'concert', null),
    ]);
  });
  afterEach(async () => {
    await h.close();
  });

  it('a Mavericks fan asking for "Rangers" gets the Texas Rangers, said so', async () => {
    const c = makeConcierge(h);
    const first = await ask(c, 'mavs@customer.example', 'Two Mavericks tickets Oct 11', 'Mavs');
    expect(first.event).toBe('Dallas Mavericks vs. Phoenix Suns');
    const second = await ask(c, 'mavs@customer.example', 'Two Rangers tickets Oct 11', 'Rangers');
    expect(second.event).toBe('Texas Rangers vs. Houston Astros');
    expect(second.body).toContain("I've gone with the Texas Rangers. Tell me if you meant a different team.");
  });

  it('a new customer still gets the New York Rangers', async () => {
    const c = makeConcierge(h);
    const r = await ask(c, 'new@customer.example', 'Two Rangers tickets Oct 11', 'Rangers');
    expect(r.event).toBe('New York Rangers vs. Boston Bruins');
  });

  it('where they said they live outranks a trip they asked about', async () => {
    const c = makeConcierge(h);
    await ask(c, 'texan@customer.example', 'I live in Dallas. Two Knicks tickets Oct 13 in New York', 'Knicks');
    const [pref] = await h.db.select().from(t.contactPreferences);
    expect(pref!.region).toBe('dallas');
    const r = await ask(c, 'texan@customer.example', 'Two Rangers tickets Oct 11', 'Rangers');
    expect(r.event).toBe('Texas Rangers vs. Houston Astros');
  });

  it('a touring act is the show near them, said so', async () => {
    const c = makeConcierge(h);
    await ask(c, 'la@customer.example', "I'm based in LA. Two Lumineers tickets", 'Lumineers');
    const r = await ask(c, 'la@customer.example', 'Two Lumineers tickets', 'Lumineers again');
    expect(r.event).toBe('The Lumineers');
    expect(r.body).toContain('Crypto.com Arena');
    expect(r.body).toContain("I've gone with the Los Angeles show. Tell me if you meant another city.");
  });
});
