import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { ordinalChoice } from '@/lib/intake/pipeline';
import { openTestDb, makeConcierge, inbound } from '../harness';

async function interpretAll(h: DbHandle, c: ReturnType<typeof makeConcierge>) {
  for (let i = 0; i < 5; i++) {
    const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
    const work = leased.filter((ev) => ev.eventType === 'request.interpret');
    if (!work.length) return;
    for (const ev of work) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
  }
}

const PHILLY = '10000000-0000-4000-8000-0000000000e1';
const FOXBOROUGH = '10000000-0000-4000-8000-0000000000e2';
const SEATTLE = '10000000-0000-4000-8000-0000000000e3';
const BRIDGEPORT = '10000000-0000-4000-8000-0000000000e4';
const BAND = '20000000-0000-4000-8000-0000000000e1';
const PHILLY_SHOW = '30000000-0000-4000-8000-0000000000e1';

/**
 * "Two Metallica tickets soon in NY" got "We checked the official listings and couldn't find a scheduled
 * Metallica event in NY": the tour wasn't stopping in New York, and nothing looked further. It now names the
 * nearest shows elsewhere, closest first, and a reply with a date settles on that one.
 */
describe('not playing where they asked: the nearest shows elsewhere', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: PHILLY, name: 'Lincoln Financial Field', city: 'Philadelphia', state: 'PA', country: 'US', timezone: 'America/New_York', latitude: 39.9008, longitude: -75.1675 },
      { id: FOXBOROUGH, name: 'Gillette Stadium', city: 'Foxborough', state: 'MA', country: 'US', timezone: 'America/New_York', latitude: 42.0909, longitude: -71.2643 },
      { id: BRIDGEPORT, name: 'Hartford HealthCare Amphitheater', city: 'Bridgeport', state: 'CT', country: 'US', timezone: 'America/New_York', latitude: 41.1792, longitude: -73.1894 },
      { id: SEATTLE, name: 'Lumen Field', city: 'Seattle', state: 'WA', country: 'US', timezone: 'America/Los_Angeles', latitude: 47.5952, longitude: -122.3316 },
    ]);
    await h.db.insert(t.entities).values({ id: BAND, kind: 'artist', name: 'Metallica', slug: 'metallica', aliases: [] });
    await h.db.insert(t.events).values([
      { id: PHILLY_SHOW, name: 'Metallica: M72 World Tour', category: 'concert', venueId: PHILLY, primaryEntityId: BAND, localStartAt: new Date('2026-10-10T23:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' },
      { name: 'Metallica: M72 World Tour', category: 'concert', venueId: SEATTLE, primaryEntityId: BAND, localStartAt: new Date('2026-10-03T02:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' },
      // Connecticut is outside the New York market's radius but closer than anywhere else on the tour.
      { name: 'Metallica: M72 World Tour', category: 'concert', venueId: BRIDGEPORT, primaryEntityId: BAND, localStartAt: new Date('2026-10-24T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' },
      { name: 'Metallica: M72 World Tour', category: 'concert', venueId: FOXBOROUGH, primaryEntityId: BAND, localStartAt: new Date('2026-10-17T23:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' },
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('lists the nearest shows, closest first with the distance, then settles on the date they reply with', async () => {
    const c = makeConcierge(h);
    const from = 'metallica@customer.example';
    const first = inbound({ text: 'Two Metallica tickets soon in NY', from, subject: 'Metallica' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await interpretAll(h, c);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    const ask = sends.find((s) => s.messageClass === 'clarification')!;
    expect(ask.bodyText).toContain('Metallica isn’t playing in New York');
    expect(ask.bodyText).not.toContain('couldn\'t find a scheduled');
    // Closest first, and a coast away is left out while there is something within reach. Said as a person would:
    // the answer, the shows as a list, then one question (live Oct 3: "around then", "shows not far off", a run-on).
    expect(ask.bodyText).toContain('Hey,\n\nMetallica isn’t playing in New York. The closest shows:\n• Hartford HealthCare Amphitheater, Bridgeport, about 55 miles away: Saturday, October 24, at 7 p.m.\n• Lincoln Financial Field, Philadelphia, about 85 miles away: Saturday, October 10, at 7:30 p.m.\n• Gillette Stadium, Foxborough, about 170 miles away: Saturday, October 17, at 7:30 p.m.\n\nWhich one works? I’ll find you two seats for it, or tell me how far you’d travel.');
    expect(ask.bodyText).not.toMatch(/Got it|around then|not far off|soon\./);
    expect(ask.bodyHtml).toContain('<li style="margin:0 0 4px;">Hartford HealthCare Amphitheater, Bridgeport, about 55 miles away: Saturday, October 24, at 7 p.m.</li>');
    expect(ask.bodyText).not.toContain('Which Metallica date and venue');

    await c.ingestInbound(inbound({ text: 'Oct 10 works', from, subject: 'Re: Metallica', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(h, c);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.eventId).toBe(PHILLY_SHOW);
  });

  it('a first email naming a date that is only elsewhere settles on it and says where', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: 'Two Metallica tickets Oct 10 in NY', from: 'dated@customer.example', subject: 'Metallica' }))) as { requestId: string };
    await interpretAll(h, c);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.eventId).toBe(PHILLY_SHOW);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(sends.some((s) => s.bodyText.includes('Metallica isn’t playing in New York then, so I’ve gone with Lincoln Financial Field in Philadelphia (about 85 miles from New York). Tell me if that’s too far.'))).toBe(true);
  });

  // Live Oct 3: "Yes the first one would be great. How much are the cheapest tickets? I need 2" got the same two
  // Mohegan Sun nights back, word for word. The first one on the list is the one they get.
  it('"the first one" after the list settles on the first show listed, never the same list again', async () => {
    const c = makeConcierge(h);
    const from = 'firstone@customer.example';
    const first = inbound({ text: 'Looking for the best available Metallica tickets. Are they playing near new york soon?', from, subject: 'Metallica' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await interpretAll(h, c);
    await c.ingestInbound(inbound({ text: 'Yes the first one would be great. How much are the cheapest tickets_.I need 2', from, subject: 'Re: Metallica', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(h, c);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const [bridgeport] = await h.db.select({ id: t.events.id }).from(t.events).where(eq(t.events.venueId, BRIDGEPORT));
    expect(req!.eventId).toBe(bridgeport!.id);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(sends.filter((s) => s.bodyText.includes('The closest shows:'))).toHaveLength(1);
  });

  it('picks by position only when the message picks by position', () => {
    expect(ordinalChoice('Yes the first one would be great', 2)).toBe(0);
    expect(ordinalChoice('the second show please', 3)).toBe(1);
    expect(ordinalChoice('Let’s do the last one.', 3)).toBe(2);
    expect(ordinalChoice('option 2', 3)).toBe(1);
    expect(ordinalChoice('the third one', 2)).toBeNull();
    expect(ordinalChoice('It’s my first time at a concert, first row would be nice', 3)).toBeNull();
  });

  it('when every show is far, says so and still names the nearest', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: 'Two Metallica tickets in Chicago', from: 'chicago@customer.example', subject: 'Metallica' }))) as { requestId: string };
    await interpretAll(h, c);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    const body = sends.find((s) => s.messageClass === 'clarification')!.bodyText;
    expect(body).toContain('Metallica isn’t playing in Chicago. The nearest I can find are a trip away:');
    expect(body).toMatch(/Lincoln Financial Field, Philadelphia, about [\d,]+ miles away: /);
    expect(body).not.toContain('Seattle'); // three nearest to Chicago: the east coast shows, not the west
  });

  it('asking for the city they play in still resolves directly', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: 'Two Metallica tickets in Philly', from: 'philly@customer.example', subject: 'Metallica' }))) as { requestId: string };
    await interpretAll(h, c);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.eventId).toBe(PHILLY_SHOW);
  });
});
