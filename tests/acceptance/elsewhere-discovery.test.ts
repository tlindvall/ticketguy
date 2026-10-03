import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW, FIXTURE_OFFERS } from '@/lib/fixtures';
import { DISCOVERY_SOURCE_ID } from '@/lib/catalog/sync';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';

/**
 * Live, Oct 1 2026: "Metallica tickets" from New York got "the nearest shows are a trip away" and two Las Vegas
 * dates (about 2,200 miles), while the tour was playing Connecticut. The catalog already held the Sphere shows from
 * an earlier lookup, and the nearest-elsewhere search only asked the provider when it had nothing at all. Now a
 * catalog with nothing within reach asks the provider nationwide before any far show is called the nearest.
 */
const SPHERE = '30000000-0000-4000-8000-00000000a001';
const BAND = '30000000-0000-4000-8000-00000000b001';
const tmHartford = {
  id: 'tm-met-ct', name: 'Metallica: M72 World Tour', type: 'event', url: 'https://www.ticketmaster.com/event/tm-met-ct',
  dates: { start: { localDate: '2026-10-10', localTime: '19:30:00', dateTime: '2026-10-10T23:30:00Z', timeTBA: false, noSpecificTime: false }, timezone: 'America/New_York', status: { code: 'onsale' } },
  classifications: [{ primary: true, segment: { name: 'Music' }, genre: { name: 'Rock' }, subGenre: { name: 'Hard Rock' } }],
  _embedded: {
    venues: [{ id: 'KovZpZAct', name: 'Rentschler Field', city: { name: 'East Hartford' }, state: { stateCode: 'CT' }, country: { countryCode: 'US' }, timezone: 'America/New_York', location: { latitude: '41.7616', longitude: '-72.6504' } }],
    attractions: [{ id: 'K8vZ9171met', name: 'Metallica', url: 'https://www.ticketmaster.com/artist/K8vZ9171met', classifications: [{ primary: true, segment: { name: 'Music' }, genre: { name: 'Rock' } }] }],
  },
};

describe('a far show on file never stands in for a closer one the provider knows', () => {
  let h: DbHandle;
  let keywordCalls = 0;
  let providerHasHartford = true;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if ((url.searchParams.get('keyword') ?? '').toLowerCase() === 'metallica') keywordCalls += 1;
    return new Response(JSON.stringify({ _embedded: { events: providerHasHartford && (url.searchParams.get('keyword') ?? '').toLowerCase() === 'metallica' ? [tmHartford] : [] } }), { status: 200 });
  }) as typeof fetch;
  const concierge = (over: Record<string, string> = {}) => new Concierge({ db: h.db, env: testEnv({ TICKETMASTER_DISCOVERY_ENABLED: 'true', TICKETMASTER_DISCOVERY_API_KEY: 'tm-test-key', ...over }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: null, fixtureOffers: FIXTURE_OFFERS, discoveryFetch: fetchImpl });
  const ask = async (c: Concierge, text: string, from: string) => {
    const r = (await c.ingestInbound(inbound({ text, from, subject: 'Metallica' }))) as { requestId: string };
    for (let i = 0; i < 6; i++) {
      const due = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
      if (!due.length) break;
      for (const ev of due) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return sends.at(-1)!.bodyText;
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.adapterConfigs).values({ sourceId: DISCOVERY_SOURCE_ID, implementation: 'ticketmaster_discovery', enabled: true, capabilities: ['discovery', 'event_lookup'], accessApprovalEvidence: 'test', monitoringAllowed: false, dailyCallLimit: null, reviewedBy: 'test' }).onConflictDoUpdate({ target: t.adapterConfigs.sourceId, set: { enabled: true, implementation: 'ticketmaster_discovery' } });
    await h.db.insert(t.venues).values({ id: SPHERE, name: 'Sphere', city: 'Las Vegas', state: 'NV', country: 'US', timezone: 'America/Los_Angeles', latitude: 36.1208, longitude: -115.1619 });
    await h.db.insert(t.entities).values({ id: BAND, kind: 'artist', name: 'Metallica', slug: 'metallica-x', aliases: [] });
    // On file from an earlier lookup: two Sphere dates, and nothing closer to New York.
    await h.db.insert(t.events).values([
      { name: 'Metallica: M72 World Tour', category: 'concert', venueId: SPHERE, primaryEntityId: BAND, localStartAt: new Date('2026-10-02T03:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' },
      { name: 'Metallica: M72 World Tour', category: 'concert', venueId: SPHERE, primaryEntityId: BAND, localStartAt: new Date('2026-10-04T03:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' },
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('asks the provider nationwide and offers Connecticut, not Las Vegas, to New York', async () => {
    const body = await ask(concierge(), 'Two Metallica tickets in New York', 'met-ny@customer.example');
    expect(keywordCalls).toBeGreaterThanOrEqual(1);
    expect(body).toMatch(/Metallica isn’t playing in New York\. The closest (?:is|show is at) Rentschler Field in East Hartford, about 1\d\d miles away/);
    expect(body).not.toMatch(/Sphere|Las Vegas|a trip away/);
  });

  it('with the provider knowing nothing closer, the far shows are offered and said to be what I can find', async () => {
    providerHasHartford = false;
    // The Hartford show the first case synced is taken back off file, mapping first.
    const hartford = await h.db.select({ id: t.events.id }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(eq(t.venues.city, 'East Hartford'));
    for (const { id } of hartford) {
      await h.db.delete(t.eventSourceMappings).where(eq(t.eventSourceMappings.eventId, id));
      await h.db.delete(t.events).where(eq(t.events.id, id));
    }
    const body = await ask(concierge(), 'Two Metallica tickets in New York', 'met-ny2@customer.example');
    expect(body).toMatch(/Metallica isn’t playing in New York\. The nearest I can find is Sphere in Las Vegas, about 2,2\d\d miles away, on two nights:\n• /);
  });

  it('with no provider at all, what is on file is offered rather than nothing', async () => {
    const body = await ask(concierge({ TICKETMASTER_DISCOVERY_ENABLED: 'false' }), 'Two Metallica tickets in New York', 'met-ny3@customer.example');
    expect(body).toContain('The nearest I can find is Sphere in Las Vegas');
    expect(body).toContain('Sphere');
  });
});

describe('a correction or a "why didn’t you" is owned before the answer', () => {
  let h: DbHandle;
  const MOHEGAN = '30000000-0000-4000-8000-00000000a002';
  const SPHERE2 = '30000000-0000-4000-8000-00000000a003';
  const BAND2 = '30000000-0000-4000-8000-00000000b002';
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: SPHERE2, name: 'Sphere', city: 'Las Vegas', state: 'NV', country: 'US', timezone: 'America/Los_Angeles', latitude: 36.1208, longitude: -115.1619 },
      { id: MOHEGAN, name: 'Mohegan Sun Arena', city: 'Uncasville', state: 'CT', country: 'US', timezone: 'America/New_York', latitude: 41.4912, longitude: -72.0912 },
    ]);
    await h.db.insert(t.entities).values({ id: BAND2, kind: 'artist', name: 'Metallica', slug: 'metallica-y', aliases: [] });
    await h.db.insert(t.events).values([
      { name: 'Metallica: M72 World Tour', category: 'concert', venueId: SPHERE2, primaryEntityId: BAND2, localStartAt: new Date('2026-10-02T03:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' },
      { name: 'Metallica: M72 World Tour', category: 'concert', venueId: MOHEGAN, primaryEntityId: BAND2, localStartAt: new Date('2026-11-20T01:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' },
      { name: 'Metallica: M72 World Tour', category: 'concert', venueId: MOHEGAN, primaryEntityId: BAND2, localStartAt: new Date('2026-11-22T01:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'offsale' },
    ]);
  });
  afterAll(async () => {
    await h.close();
  });
  const turn = async (c: Concierge, text: string, prev: ReturnType<typeof inbound> | null) => {
    const m = inbound({ text, from: 'owned@customer.example', subject: prev ? 'Re: Metallica' : 'Metallica', inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
    const r = (await c.ingestInbound(m)) as { requestId: string };
    for (let i = 0; i < 6; i++) {
      const due = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
      if (!due.length) break;
      for (const ev of due) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return { m, body: sends.at(-1)!.bodyText };
  };
  it('owns the miss, then gives the Connecticut dates; a second "why didn’t you" is owned again, not re-asked as new', async () => {
    const c = new Concierge({ db: h.db, env: testEnv(), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: null, fixtureOffers: FIXTURE_OFFERS });
    const first = await turn(c, 'Metallica tickets', null);
    expect(first.body).toContain('Metallica tickets. Got it.');
    const second = await turn(c, 'they are playing in CT. why would you not suggest that?', first.m);
    expect(second.body.split('\n\n')[1]).toBe('You’re right, I missed that. Here’s what I have now.');
    expect(second.body).not.toContain('Got it.');
    expect(second.body).toMatch(/Mohegan Sun Arena/);
    const third = await turn(c, "why didn't you tell me about the CT show before suggesting las vegas?", second.m);
    expect(third.body.split('\n\n')[1]).toBe('You’re right, I missed that, and I should have checked the whole tour before suggesting anything further away. Here’s what I have now.');
    expect(third.body).toMatch(/Mohegan Sun Arena/);
    expect(third.body).not.toContain('Got it.');
  });
});
