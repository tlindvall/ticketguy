import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, testEnv, inbound } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW, FIXTURE_OFFERS } from '@/lib/fixtures';
import { DISCOVERY_SOURCE_ID } from '@/lib/catalog/sync';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';

/**
 * Live, "Two Metallica tickets soon in NY" still got "couldn't find a scheduled Metallica event in NY", and
 * "They are playing in Connecticut" got the same reply again. The geography tests passed because the shows were
 * already in the catalog; live, they come from the provider. Two causes, both here:
 *  - the national search that looks beyond New York was skipped as "fresh" because the New York search had just
 *    run for the same name (a search with no place counted any recent search as the same one);
 *  - "Connecticut" in a reply was kept beside the old city ("NY" with state CT) and never searched as a state.
 */

const METALLICA = { id: 'K8vZ9171ob7', name: 'Metallica', segment: 'Music', genre: 'Rock', subGenre: 'Hard Rock' };
const ctShow = {
  id: 'tm-metallica-ct',
  name: 'Metallica: M72 World Tour',
  type: 'event',
  url: 'https://www.ticketmaster.com/event/tm-metallica-ct',
  dates: { start: { localDate: '2026-10-24', localTime: '19:00:00', dateTime: '2026-10-24T23:00:00Z', timeTBA: false, noSpecificTime: false }, timezone: 'America/New_York', status: { code: 'onsale' } },
  classifications: [{ primary: true, segment: { name: 'Music' }, genre: { name: 'Rock' }, subGenre: { name: 'Hard Rock' } }],
  _embedded: {
    venues: [{ id: 'KovZ-ct', name: 'Hartford HealthCare Amphitheater', city: { name: 'Bridgeport' }, state: { stateCode: 'CT' }, country: { countryCode: 'US' }, timezone: 'America/New_York', location: { latitude: '41.1792', longitude: '-73.1894' } }],
    attractions: [{ id: METALLICA.id, name: METALLICA.name, url: 'https://www.ticketmaster.com/artist/K8vZ9171ob7', classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' }, subGenre: { name: 'Hard Rock' } }] }],
  },
};

type Seen = { geo: boolean; state: string | null; city: string | null };
/** A provider that has the Connecticut show and answers each search the way the real one would. */
function provider(answer: (q: Seen) => boolean) {
  const calls: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const q = { geo: !!u.searchParams.get('geoPoint'), state: u.searchParams.get('stateCode'), city: u.searchParams.get('city') };
    calls.push(q);
    return new Response(JSON.stringify(answer(q) ? { _embedded: { events: [ctShow] } } : {}), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function interpretAll(h: DbHandle, c: Concierge) {
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

async function setup() {
  const h = await openTestDb();
  await h.db.insert(t.adapterConfigs).values({ sourceId: DISCOVERY_SOURCE_ID, implementation: 'ticketmaster_discovery', enabled: true, capabilities: ['discovery', 'event_lookup'], accessApprovalEvidence: 'test: developer terms accepted', monitoringAllowed: false, dailyCallLimit: null, reviewedBy: 'test' });
  // Known by name (the rules extractor reads only names it knows), with nothing scheduled on file.
  await h.db.insert(t.entities).values({ kind: 'artist', name: 'Metallica', slug: 'metallica', aliases: [], externalIds: { [DISCOVERY_SOURCE_ID]: METALLICA.id } });
  return h;
}
const concierge = (h: DbHandle, fetchImpl: typeof fetch) =>
  new Concierge({ db: h.db, env: testEnv({ TICKETMASTER_DISCOVERY_ENABLED: 'true', TICKETMASTER_DISCOVERY_API_KEY: 'tm-test-key' }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: null, fixtureOffers: FIXTURE_OFFERS, discoveryFetch: fetchImpl });

describe('not playing where they asked, with the shows coming from the provider', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.close();
  });

  it('asks the provider nationally after the New York search comes back empty, and offers Connecticut', async () => {
    // Around New York: nothing. Nationally: the Connecticut show.
    const p = provider((q) => !q.geo && !q.state && !q.city);
    const c = concierge(h, p.fetchImpl);
    const r = (await c.ingestInbound(inbound({ text: 'Two Metallica tickets soon in NY', from: 'soon@customer.example', subject: 'Metallica' }))) as { requestId: string };
    await interpretAll(h, c);
    expect(p.calls).toEqual([{ geo: true, state: null, city: null }, { geo: false, state: null, city: null }]);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    const body = sends.map((s) => s.bodyText).join('\n');
    expect(body).not.toContain('couldn\'t find a scheduled');
    expect(body).toContain('Hartford HealthCare Amphitheater');
    expect(body).toContain('Bridgeport');
  });
});

describe('a reply that moves the place: "They are playing in Connecticut"', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.close();
  });

  it('searches Connecticut, not New York, and settles on the show there', async () => {
    // Only a Connecticut search finds it (as when the national page is crowded out by other stops).
    const p = provider((q) => q.state === 'CT');
    const c = concierge(h, p.fetchImpl);
    const from = 'ct@customer.example';
    const first = inbound({ text: 'Two Metallica tickets soon in NY', from, subject: 'Metallica' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await interpretAll(h, c);
    const [ask] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(ask!.bodyText).toContain('couldn\'t find a scheduled Metallica event in New York');

    await c.ingestInbound(inbound({ text: 'They are playing in connecticut.', from, subject: 'Re: Metallica', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(h, c);
    expect(p.calls.some((q) => q.state === 'CT')).toBe(true);
    const [version] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId)).orderBy(t.requestVersions.revision).limit(2).offset(1);
    expect(version!.brief).toMatchObject({ city: null, state: 'CT', performerOrTeam: expect.stringMatching(/metallica/i), quantity: 2 });
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const [ev] = await h.db.select().from(t.events).where(eq(t.events.id, req!.eventId!));
    expect(ev!.name).toBe('Metallica: M72 World Tour');
    // Settled, so it goes on to research the prices; the "couldn't find" email is not sent again.
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(sends).toHaveLength(1);
    expect(req!.state).not.toBe('needs_clarification');
  });
});
