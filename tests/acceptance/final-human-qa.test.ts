import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq, sql } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { RecordedModelExtractor } from './qa-r8-harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { DISCOVERY_SOURCE_ID, syncFromDiscovery } from '@/lib/catalog/sync';
import { TicketmasterDiscoveryAdapter } from '@/lib/sources/adapters';

/**
 * Final human QA (Oct 2 2026, real Gmail, build dadd21f): the exact customer messages, replayed against a local
 * catalog shaped like Ticketmaster's (attraction names as Ticketmaster gives them, no aliases added by us).
 */
const NOW = new Date('2026-10-02T12:28:31Z');
const RODGERS = '7f100000-0000-4000-8000-000000000001';
const HAMILTON = '7f100000-0000-4000-8000-000000000002';
const HAM_MATINEE = '7f100000-0000-4000-8000-000000000003';
const HAM_EVENING = '7f100000-0000-4000-8000-000000000004';
const HAM_OPENING = 'Hey, trying to take my wife to Hamilton in New York this Sunday afternoon. Is buying here the best way in, or can you get cheaper tickets?\n\nhttps://broadwaydirect.com/show/hamilton/';

describe('Final human QA replays', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; requestId: string };
  // What the production model read on the day, from its reply ("Two Hamilton tickets this Sunday afternoon").
  const LIVE = new Map<string, ConstructorParameters<typeof RecordedModelExtractor>[0] extends Map<string, infer V> ? V : never>([
    [HAM_OPENING.trim(), { intent: 'new_search', performerOrTeam: 'Hamilton', city: 'New York', dateExpression: 'this Sunday afternoon', resolvedLocalDate: '2026-10-04', quantity: 2 }],
  ]);
  const converse = async (turns: string[], now = NOW): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => now, env: testEnv({ SERVICE_POLICY_MODE: 'enforce' }), extractor: new RecordedModelExtractor(LIVE) });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    const seen = new Set<string>();
    for (const text of turns) {
      const m = inbound({ text, from: `final-${n}@customer.example`, subject: prev ? 'Re: Hamilton' : 'Hamilton', inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null, receivedAt: now });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let i = 0; i < 8; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, now);
        }
      }
      const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))).filter((x) => !seen.has(x.id));
      const recs = (await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))).filter((x) => !seen.has(x.id));
      for (const x of [...sends, ...recs]) seen.add(x.id);
      const reply = recs[0] ?? sends.find((x) => !/Here's what I have/.test(x.bodyText)) ?? sends[0];
      out.push({ text: reply ? reply.bodyText.split('\nTicket Guy\n')[0]! : '(no reply)', requestId: r.requestId });
    }
    return out;
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: RODGERS, name: 'Richard Rodgers Theatre', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    // As Ticketmaster names the attraction, and as our catalog sync stores it: "Hamilton (NY)", no aliases.
    await h.db.insert(t.entities).values({ id: HAMILTON, kind: 'performer', name: 'Hamilton (NY)', slug: 'hamilton-ny-final', aliases: [] });
    const onsale = { status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: false, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-01-01T15:00:00Z') } as const;
    await h.db.insert(t.events).values([
      { id: HAM_MATINEE, name: 'Hamilton (NY)', category: 'broadway', venueId: RODGERS, primaryEntityId: HAMILTON, localStartAt: new Date('2026-10-04T17:00:00Z'), ...onsale },
      { id: HAM_EVENING, name: 'Hamilton (NY)', category: 'broadway', venueId: RODGERS, primaryEntityId: HAMILTON, localStartAt: new Date('2026-10-04T23:30:00Z'), ...onsale },
    ]);
    await h.db.insert(t.eventSourceMappings).values([
      { eventId: HAM_MATINEE, sourceId: 'ticketmaster', sourceEventId: 'Z1r9uZrrZbpZ1AvjV8p', authoritativeUrl: 'https://www.ticketmaster.com/hamilton-ny-new-york-new-york-10-04-2026/event/Z1r9uZrrZbpZ1AvjV8p', role: 'discovery', confidence: 'provider_id' },
      { eventId: HAM_EVENING, sourceId: 'ticketmaster', sourceEventId: 'Z1r9uZrrZbpZ1AvjV9q', authoritativeUrl: 'https://www.ticketmaster.com/hamilton-ny-new-york-new-york-10-04-2026/event/Z1r9uZrrZbpZ1AvjV9q', role: 'discovery', confidence: 'provider_id' },
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('control: a touring Hamilton elsewhere that day does not take the New York matinee\'s place', async () => {
    const TOUR = '7f100000-0000-4000-8000-000000000012';
    const CHI = '7f100000-0000-4000-8000-000000000011';
    await h.db.insert(t.venues).values({ id: CHI, name: 'CIBC Theatre', aliases: [], city: 'Chicago', state: 'IL', country: 'US', timezone: 'America/Chicago' });
    await h.db.insert(t.entities).values({ id: TOUR, kind: 'performer', name: 'Hamilton (Touring)', slug: 'hamilton-touring-final', aliases: [] });
    await h.db.insert(t.events).values({ id: '7f100000-0000-4000-8000-000000000013', name: 'Hamilton (Touring)', category: 'broadway', venueId: CHI, primaryEntityId: TOUR, localStartAt: new Date('2026-10-04T18:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: false, saleStatus: 'onsale' });
    const [first] = await converse([HAM_OPENING]);
    expect(first!.text).toContain('Hamilton (NY)\nRichard Rodgers Theatre, New York · Sun, Oct 4, 1:00 PM EDT');
  });

  it('R1-HUMAN-02: with the matinee on file, the exact opening finds Sun Oct 4 at 1pm (afternoon), two tickets', async () => {
    const [first] = await converse([HAM_OPENING]);
    expect(first!.text).toContain('Hamilton (NY)\nRichard Rodgers Theatre, New York · Sun, Oct 4, 1:00 PM EDT · 2 tickets');
    expect(first!.text).not.toMatch(/couldn.t find/);
    // LAUNCH-07 (final launch QA L04): where they started stays in the reply, as an event page, beside the catalog's seller.
    expect(first!.text).toContain('Event page on Broadway Direct: https://broadwaydirect.com/show/hamilton/');
    expect(first!.text).toContain('Event page on Ticketmaster:');
    expect(first!.text).not.toMatch(/Buy (?:tickets )?on Broadway Direct/);
  });

  // The catalog after weeks of syncs: "Hamilton" is a surname, so Discovery brings in Anthony Hamilton, Bethany Hamilton
  // and the rest. The name lookup took the first ten names containing "hamilton" alphabetically, and those sort
  // ahead of "Hamilton (NY)": the show was on file and never looked at (Oct 2 live: "couldn't find a Hamilton
  // performance in New York on Sun, Oct 4", with or without the provider's fresh page).
  it('R1-HUMAN-02: a dozen artists named Hamilton on file don’t crowd out the show itself', async () => {
    const names = ['Anthony', 'Ashley', 'Bethany', 'Brian', 'Carl', 'Chico', 'Dan', 'David', 'Ed', 'Florence', 'George', 'Gwen'].map((f) => `${f} Hamilton`);
    await h.db.insert(t.entities).values(names.map((name, i) => ({ id: `7f100000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`, kind: 'performer', name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-final`, aliases: [] })));
    const [first] = await converse([HAM_OPENING]);
    expect(first!.text).toContain('Hamilton (NY)\nRichard Rodgers Theatre, New York · Sun, Oct 4, 1:00 PM EDT · 2 tickets');
    expect(first!.text).not.toMatch(/couldn.t find/);
  });

  // An exact name is tried first ("rangers" is the two Rangers teams, not their alumni), but one with nothing that fits
  // doesn't end the search: an artist billed as just "Hamilton" with no New York date leaves the show to be found.
  it('R1-HUMAN-02: an exact "Hamilton" with nothing in New York that day falls through to "Hamilton (NY)"', async () => {
    const OTHER = '7f100000-0000-4000-8000-000000000301';
    const AUSTIN = '7f100000-0000-4000-8000-000000000302';
    await h.db.insert(t.venues).values({ id: AUSTIN, name: 'Moody Theater', aliases: [], city: 'Austin', state: 'TX', country: 'US', timezone: 'America/Chicago' });
    await h.db.insert(t.entities).values({ id: OTHER, kind: 'performer', name: 'Hamilton', slug: 'hamilton-band-final', aliases: [] });
    await h.db.insert(t.events).values({ id: '7f100000-0000-4000-8000-000000000303', name: 'Hamilton', category: 'concert', venueId: AUSTIN, primaryEntityId: OTHER, localStartAt: new Date('2026-10-20T01:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: false, saleStatus: 'onsale' });
    const [first] = await converse([HAM_OPENING]);
    expect(first!.text).toContain('Hamilton (NY)\nRichard Rodgers Theatre, New York · Sun, Oct 4, 1:00 PM EDT · 2 tickets');
  });
});

/**
 * R1-HUMAN-02, as far as the evidence goes: the matinee wasn't in our catalog after the provider was asked. Our search
 * asked Ticketmaster for a page of 20, sorted by date, and recorded the search as covering its whole window whether or
 * not the page ran out. A keyword like "Hamilton" also matches other events near New York (another artist, a venue
 * named for a township), so a page can fill before the date asked for, and a later search of that date was then
 * skipped as fresh. The stand-in Discovery API below answers each search the way the real one does, with that flood.
 * Production's own catalog rows weren't inspected, so this is the mechanism the fix closes, not a proven trace.
 */
describe('R1-HUMAN-02: a search that ran out of page is not a search of the whole window', () => {
  let h: DbHandle;
  const tmEvent = (id: string, name: string, at: string, venue: { id: string; name: string; city: string }, attraction: string) => ({
    id, name, type: 'event', url: `https://www.ticketmaster.com/event/${id}`,
    dates: { start: { localDate: at.slice(0, 10), dateTime: at, timeTBA: false, noSpecificTime: false }, timezone: 'America/New_York', status: { code: 'onsale' } },
    classifications: [{ primary: true, segment: { name: 'Arts & Theatre' }, genre: { name: 'Theatre' }, subGenre: { name: 'Musical' } }],
    _embedded: {
      venues: [{ id: venue.id, name: venue.name, city: { name: venue.city }, state: { stateCode: 'NY' }, country: { countryCode: 'US' }, timezone: 'America/New_York', location: { latitude: '40.7590', longitude: '-73.9867' } }],
      attractions: [{ id: `att-${attraction}`, name: attraction, url: `https://www.ticketmaster.com/artist/${attraction}`, classifications: [{ segment: { name: 'Arts & Theatre' }, genre: { name: 'Theatre' }, subGenre: { name: 'Musical' } }] }],
    },
  });
  const rodgers = { id: 'KovZpZAEkn6A', name: 'Richard Rodgers Theatre', city: 'New York' };
  // The show: Sat 2pm and 7pm, Sun 1pm and 7pm (ET).
  const hamilton = ['2026-10-03T18:00:00Z', '2026-10-03T23:00:00Z', '2026-10-04T17:00:00Z', '2026-10-04T23:00:00Z', '2026-10-06T23:00:00Z'].map((at) => tmEvent(`ham-${at}`, 'Hamilton (NY)', at, rodgers, 'Hamilton (NY)'));
  // The flood: other events the keyword matches, all before Sunday.
  const flood = Array.from({ length: 22 }, (_, i) => tmEvent(`flood-${i}`, `Hamilton Township Fall Fair ${i + 1}`, `2026-10-03T${String(13 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00Z`, { id: 'KovZ-twp', name: 'Hamilton Township Park', city: 'New York' }, 'Hamilton Township Fall Fair'));
  const all = [...hamilton, ...flood].sort((a, b) => a.dates.start.dateTime.localeCompare(b.dates.start.dateTime));
  const calls: Array<{ start: string | null; end: string | null; size: number }> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const start = u.searchParams.get('startDateTime');
    const end = u.searchParams.get('endDateTime');
    const size = Number(u.searchParams.get('size') ?? 20);
    calls.push({ start, end, size });
    const kw = (u.searchParams.get('keyword') ?? '').toLowerCase();
    const events = kw ? all.filter((e) => e.name.toLowerCase().includes(kw) && (!start || e.dates.start.dateTime >= start) && (!end || e.dates.start.dateTime <= end)).slice(0, size) : [];
    return new Response(JSON.stringify(events.length ? { _embedded: { events } } : {}), { status: 200 });
  }) as typeof fetch;
  const LIVE = () => new Map([[HAM_OPENING.trim(), { intent: 'new_search', performerOrTeam: 'Hamilton', city: 'New York', dateExpression: 'this Sunday afternoon', resolvedLocalDate: '2026-10-04', quantity: 2 }]]);
  const concierge = () => new Concierge({ db: h.db, env: testEnv({ TICKETMASTER_DISCOVERY_ENABLED: 'true', TICKETMASTER_DISCOVERY_API_KEY: 'tm-test-key', SERVICE_POLICY_MODE: 'enforce' }), extractor: new RecordedModelExtractor(LIVE() as never), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: null, discoveryFetch: fetchImpl });
  let n = 0;
  const opening = async () => {
    n += 1;
    const c = concierge();
    const r = (await c.ingestInbound(inbound({ text: HAM_OPENING, from: `hamilton-live-${n}@customer.example`, subject: 'Hamilton', receivedAt: NOW }))) as { requestId: string };
    for (let i = 0; i < 6; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: NOW });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
      }
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const [ev] = req?.eventId ? await h.db.select().from(t.events).where(eq(t.events.id, req.eventId)) : [];
    const bodies = [...(await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))).map((x) => x.bodyText), ...(await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))).map((x) => x.bodyText)].join('\n');
    return { event: ev ?? null, bodies };
  };
  const reset = async () => {
    await h.db.delete(t.catalogSyncs);
    calls.length = 0;
  };

  const fresh = async () => {
    if (h) await h.close();
    h = await openTestDb();
    await h.db.insert(t.adapterConfigs).values({ sourceId: DISCOVERY_SOURCE_ID, implementation: 'ticketmaster_discovery', enabled: true, capabilities: ['discovery', 'event_lookup'], accessApprovalEvidence: 'test: developer terms accepted', monitoringAllowed: false, dailyCallLimit: null, reviewedBy: 'test' }).onConflictDoUpdate({ target: t.adapterConfigs.sourceId, set: { enabled: true, implementation: 'ticketmaster_discovery' } });
    calls.length = 0;
  };
  beforeAll(fresh);
  afterAll(async () => {
    await h.close();
  });

  it('a full page records the dates it reached, so a search past them is asked again; a page with room is trusted', async () => {
    await reset();
    const adapter = new TicketmasterDiscoveryAdapter('tm-test-key', true, fetchImpl);
    const page = await syncFromDiscovery(h.db, adapter, { keyword: 'Hamilton', city: 'New York', startDateTime: '2026-10-03T00:00:00Z', endDateTime: '2026-10-05T23:59:59Z', size: 20, trigger: 'interpret', now: new Date('2026-10-02T11:00:00Z') });
    expect(page).toMatchObject({ status: 'success', eventsSeen: 20, truncated: true });
    const [rec] = await h.db.select().from(t.catalogSyncs).orderBy(desc(t.catalogSyncs.syncedAt)).limit(1);
    expect(rec!.windowTo! < '2026-10-04').toBe(true);
    const sunday = await syncFromDiscovery(h.db, adapter, { keyword: 'Hamilton', city: 'New York', startDateTime: '2026-10-03T00:00:00Z', endDateTime: '2026-10-05T23:59:59Z', size: 100, trigger: 'interpret', now: new Date('2026-10-02T12:28:00Z') });
    expect(sunday.status).toBe('success');
    expect(sunday.truncated).toBeUndefined();
    const again = await syncFromDiscovery(h.db, adapter, { keyword: 'Hamilton', city: 'New York', startDateTime: '2026-10-04T00:00:00Z', endDateTime: '2026-10-04T23:59:59Z', size: 100, trigger: 'interpret', now: new Date('2026-10-02T12:29:00Z') });
    expect(again.status).toBe('skipped_fresh');
  });

  it('the exact opening with the flood: a page of 100 reaches Sunday, and the 1pm matinee is the event', async () => {
    await reset();
    const r = await opening();
    expect(calls.every((q) => q.size === 100)).toBe(true);
    expect(r.event?.localStartAt.toISOString()).toBe('2026-10-04T17:00:00.000Z');
    expect(r.bodies).not.toMatch(/couldn.t find/);
  });

  it('after an old whole-window record from a page that ran out: the cached miss is asked again, once, fresh', async () => {
    await fresh();
    // The flood and Saturday on file from the earlier search, Sunday not.
    const adapter = new TicketmasterDiscoveryAdapter('tm-test-key', true, fetchImpl);
    await syncFromDiscovery(h.db, adapter, { keyword: 'Hamilton', city: 'New York', startDateTime: '2026-10-03T00:00:00Z', endDateTime: '2026-10-05T23:59:59Z', size: 20, trigger: 'interpret', now: new Date('2026-10-02T11:00:00Z') });
    expect((await h.db.select().from(t.events).where(sql`${t.events.name} = 'Hamilton (NY)' and ${t.events.localStartAt} >= ${'2026-10-04T00:00:00Z'}::timestamptz`)).length).toBe(0);
    await h.db.delete(t.catalogSyncs);
    calls.length = 0;
    // As production would have held it: the search recorded as covering its whole window, under any place key.
    const keys = ['new york', ...((await h.db.selectDistinct({ city: t.catalogSyncs.city }).from(t.catalogSyncs)).map((k) => k.city).filter((k): k is string => !!k))];
    for (const city of new Set([...keys, null])) await h.db.insert(t.catalogSyncs).values({ sourceId: DISCOVERY_SOURCE_ID, keywordNormalized: 'hamilton', city, windowFrom: '2026-10-01T00:00:00Z', windowTo: '2026-12-30T23:59:59Z', status: 'success', eventCount: 20, trigger: 'interpret', syncedAt: new Date('2026-10-02T11:00:00Z') });
    const r = await opening();
    expect(r.event?.localStartAt.toISOString()).toBe('2026-10-04T17:00:00.000Z');
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it('when the provider truly has nothing that day, the reply says what was searched, not that nothing is scheduled', async () => {
    await fresh();
    const saved = hamilton.splice(2, 2);
    all.splice(0, all.length, ...[...hamilton, ...flood].sort((a, b) => a.dates.start.dateTime.localeCompare(b.dates.start.dateTime)));
    const r = await opening();
    hamilton.splice(2, 0, ...saved);
    all.splice(0, all.length, ...[...hamilton, ...flood].sort((a, b) => a.dates.start.dateTime.localeCompare(b.dates.start.dateTime)));
    expect(r.bodies).not.toMatch(/scheduled Hamilton|no Hamilton event/i);
    expect(r.bodies).toMatch(/I searched Ticketmaster.s listings and couldn.t find a Hamilton performance in New York on Sun, Oct 4\. That.s what I can search, not proof there isn.t one/);
  });
});

