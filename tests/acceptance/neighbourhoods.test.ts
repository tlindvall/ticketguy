import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW, FX } from '@/lib/fixtures';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';

/**
 * "What about some of the cooler venues in like bushwick" was answered with "I checked the official listings
 * and couldn't find any live music in Bushwick": Bushwick was searched as a town of its own, and the provider
 * files its venues under Brooklyn. A neighbourhood is part of its city, kept by distance from its centre, and
 * widened to its borough when nothing is on.
 */
async function interpretAll(h: DbHandle, c: ReturnType<typeof makeConcierge>) {
  for (let i = 0; i < 5; i++) {
    const work = (await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW })).filter((ev) => ev.eventType === 'request.interpret');
    if (!work.length) return;
    for (const ev of work) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
  }
}

const HOUSE_OF_YES = '10000000-0000-4000-8000-0000000000d1';
const ELSEWHERE = '10000000-0000-4000-8000-0000000000d2';
const BARCLAYS = '10000000-0000-4000-8000-0000000000d3';

describe('neighbourhoods are part of their city', () => {
  let h: DbHandle;
  const lastSend = async (requestId: string) => (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).at(-1)!;
  const ask = async (c: ReturnType<typeof makeConcierge>, text: string, from: string) => {
    const r = await c.ingestInbound(inbound({ text, from, subject: 'Gigs' }));
    await interpretAll(h, c);
    return (r as { requestId: string }).requestId;
  };
  const show = (name: string, venueId: string, at: string, genre: string | null) => ({ name, category: 'concert', genre, venueId, primaryEntityId: null, isHome: null, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true });

  beforeAll(async () => {
    h = await openTestDb();
    // The provider files all three under Brooklyn; only their coordinates say which are in Bushwick.
    await h.db.insert(t.venues).values([
      { id: HOUSE_OF_YES, name: 'House of Yes', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7067, longitude: -73.9235 },
      { id: ELSEWHERE, name: 'Elsewhere', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7094, longitude: -73.9232 },
      { id: BARCLAYS, name: 'Barclays Center', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.6826, longitude: -73.9754 },
    ]);
    await h.db.insert(t.events).values([
      show('Midnight Circus', HOUSE_OF_YES, '2026-10-02T02:00:00Z', 'dance/electronic / house'),
      show('Four Tet', ELSEWHERE, '2026-10-03T03:00:00Z', 'dance/electronic / techno'),
      show('Arena Pop Night', BARCLAYS, '2026-10-01T23:30:00Z', 'pop / pop'),
      // Only Barclays has anything the week after.
      show('Arena Pop Night II', BARCLAYS, '2026-10-08T23:30:00Z', 'pop / pop'),
      show('Midtown Big Show', FX.venues.msg, '2026-10-02T23:30:00Z', 'rock / rock'),
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('Bushwick lists the shows in Bushwick, not a town called Bushwick, and says where the smaller venues sell', async () => {
    const requestId = await ask(makeConcierge(h), 'What live music is on in Bushwick next week?', 'bushwick@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain('in Bushwick');
    expect(body).toContain('Midnight Circus at House of Yes');
    expect(body).toContain('Four Tet at Elsewhere');
    expect(body).not.toContain('Barclays');
    expect(body).not.toContain('Madison Square Garden');
    expect(body).not.toContain("couldn't find");
    // One sentence says where the rest are, with the link; it is not said twice.
    expect(body).toContain("A lot of the smaller venues around Bushwick sell through DICE, Eventbrite or Resident Advisor, which I can't see yet. Resident Advisor lists many of them. New York on Resident Advisor: https://ra.co/events/us/newyork");
    expect(body.match(/smaller venues/g)).toHaveLength(1);
  });

  it('nothing on in Bushwick widens to the rest of Brooklyn, and says so', async () => {
    const requestId = await ask(makeConcierge(h), 'Any live music in Bushwick on Oct 8?', 'wider@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain("Nothing in Bushwick fits, so here's the rest of Brooklyn.");
    expect(body).toContain('Arena Pop Night II at Barclays Center');
    // One result is one result.
    expect(body).toContain('Here’s the one I found:');
    expect(body).not.toContain('two picks');
  });

  it('a place we do not know, with nothing found, asks where it is instead of claiming there is nothing on', async () => {
    // The model names any town it reads; the rule-based extractor only knows a list, so this one says it.
    const base = new FixtureExtractor();
    const extractor: Extractor = { name: 'stub', extract: async (i) => ({ ...(await base.extract(i)), city: 'Frobisher Flats', state: null }) };
    const requestId = await ask(makeConcierge(h, { extractor }), 'What live music is on in Frobisher Flats next week?', 'nowhere@customer.example');
    const body = (await lastSend(requestId)).bodyText;
    expect(body).toContain("I couldn't find Frobisher Flats as a place in the official listings. Which city is it in or near? I'll look there.");
  });

  it('electronic music in New York points to Resident Advisor; elsewhere it does not, until that city is checked', async () => {
    const ny = (await lastSend(await ask(makeConcierge(h), 'Any techno parties in Brooklyn next week?', 'techno@customer.example'))).bodyText;
    expect(ny).toContain('For club nights and DJ sets, Resident Advisor is the go-to, with far more listed than I can see. New York on Resident Advisor: https://ra.co/events/us/newyork');
    const chi = (await lastSend(await ask(makeConcierge(h), 'Any techno parties in Chicago next week?', 'techno-chi@customer.example'))).bodyText;
    expect(chi).not.toContain('Resident Advisor');
  });
});
