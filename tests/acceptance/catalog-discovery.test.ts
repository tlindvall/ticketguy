import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, testEnv } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW, FIXTURE_OFFERS } from '@/lib/fixtures';
import { RequestExtractionSchema, type RequestExtraction } from '@/lib/domain/types';
import { TicketmasterDiscoveryAdapter, parseDiscoveryEvent } from '@/lib/sources/adapters';
import { categoryFor, subtypeFor, statusFor, parseMatchup, teamAliases, syncFromDiscovery, callsToday, DISCOVERY_SOURCE_ID } from '@/lib/catalog/sync';
import { prewarmCatalog } from '@/lib/catalog/prewarm';
import { researchLinksFor } from '@/lib/catalog/research-links';
import { localToInstant } from '@/lib/domain/dates';

/**
 * The catalog is what event resolution resolves against, and in live mode nothing used to fill it. These
 * tests drive the Discovery adapter with a fake fetch shaped like the real v2 payload and check that what
 * comes out is a canonical event a customer's words can find — and that every way the provider can fail
 * leaves the request answerable rather than broken.
 */

// --- A realistic Discovery v2 event, as the API returns it (price ranges included so the drop is tested) ---
function tmEvent(over: { id: string; name: string; dateTime?: string | null; localDate?: string; localTime?: string; timeTBA?: boolean; status?: string; segment?: string; genre?: string; subGenre?: string; venue?: { id: string; name: string; city: string; state: string; country?: string; tz: string }; attractions?: Array<{ id: string; name: string; segment?: string; genre?: string; subGenre?: string }> }) {
  const venue = over.venue ?? { id: 'KovZpZA7AAEA', name: 'Madison Square Garden', city: 'New York', state: 'NY', tz: 'America/New_York' };
  return {
    id: over.id,
    name: over.name,
    type: 'event',
    url: `https://www.ticketmaster.com/event/${over.id}`,
    priceRanges: [{ type: 'standard', currency: 'USD', min: 65, max: 900 }],
    dates: {
      start: { localDate: over.localDate ?? '2026-10-20', localTime: over.localTime ?? '19:00:00', dateTime: over.dateTime === undefined ? '2026-10-20T23:00:00Z' : over.dateTime, timeTBA: over.timeTBA ?? false, noSpecificTime: false },
      timezone: venue.tz,
      status: { code: over.status ?? 'onsale' },
    },
    classifications: [{ primary: true, segment: { name: over.segment ?? 'Sports' }, genre: { name: over.genre ?? 'Hockey' }, subGenre: { name: over.subGenre ?? 'NHL' } }],
    _embedded: {
      venues: [{ id: venue.id, name: venue.name, city: { name: venue.city }, state: { stateCode: venue.state }, country: { countryCode: venue.country ?? 'US' }, timezone: venue.tz }],
      attractions: (over.attractions ?? [{ id: 'K8vZ9171o-7', name: 'New York Rangers' }, { id: 'K8vZ9171obV', name: 'New Jersey Devils' }]).map((a) => ({ id: a.id, name: a.name, url: `https://www.ticketmaster.com/artist/${a.id}`, classifications: [{ segment: { name: a.segment ?? over.segment ?? 'Sports' }, genre: { name: a.genre ?? over.genre ?? 'Hockey' }, subGenre: { name: a.subGenre ?? over.subGenre ?? 'NHL' } }] })),
    },
  };
}

const fakeFetch = (eventsByKeyword: Record<string, unknown[]> | ((url: string) => Response)) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (typeof eventsByKeyword === 'function') return eventsByKeyword(url);
    const kw = decodeURIComponent(new URL(url).searchParams.get('keyword') ?? '').toLowerCase();
    return new Response(JSON.stringify({ _embedded: { events: eventsByKeyword[kw] ?? [] } }), { status: 200 });
  }) as typeof fetch;

const DEVILS_HOME = tmEvent({ id: 'tm-devils-1', name: 'New Jersey Devils vs. New York Rangers', dateTime: '2026-10-20T23:00:00Z', venue: { id: 'KovZpZAdE7', name: 'Prudential Center', city: 'Newark', state: 'NJ', tz: 'America/New_York' }, attractions: [{ id: 'K8vZ9171obV', name: 'New Jersey Devils' }, { id: 'K8vZ9171o-7', name: 'New York Rangers' }] });
const NYR_HOME = tmEvent({ id: 'tm-nyr-1', name: 'New York Rangers vs. New Jersey Devils', dateTime: '2026-10-20T23:00:00Z' });
const TEX_HOME = tmEvent({ id: 'tm-tex-1', name: 'Texas Rangers vs. Houston Astros', dateTime: '2026-10-20T23:05:00Z', genre: 'Baseball', subGenre: 'MLB', venue: { id: 'KovZpZAtex', name: 'Globe Life Field', city: 'Arlington', state: 'TX', tz: 'America/Chicago' }, attractions: [{ id: 'K8vZ917tex', name: 'Texas Rangers', genre: 'Baseball', subGenre: 'MLB' }, { id: 'K8vZ917hou', name: 'Houston Astros', genre: 'Baseball', subGenre: 'MLB' }] });

const brief = (over: Partial<RequestExtraction>): RequestExtraction =>
  RequestExtractionSchema.parse({ intent: 'new_search', eventName: null, performerOrTeam: null, city: null, state: null, dateExpression: null, resolvedLocalDate: null, quantity: 2, budgetCents: null, budgetBasis: null, seatingPreference: null, togetherRequired: null, accessibilityNeeds: null, alternativesAllowed: null, submittedUrls: [], evidence: [], ambiguities: [], ...over });

const discoveryEnv = (over: Record<string, string> = {}) => testEnv({ TICKETMASTER_DISCOVERY_ENABLED: 'true', TICKETMASTER_DISCOVERY_API_KEY: 'tm-test-key', ...over });

async function enableDiscoveryAdapter(h: DbHandle, dailyCallLimit: number | null = null) {
  await h.db.insert(t.adapterConfigs).values({ sourceId: DISCOVERY_SOURCE_ID, implementation: 'ticketmaster_discovery', enabled: true, capabilities: ['discovery', 'event_lookup'], accessApprovalEvidence: 'test: developer terms accepted', monitoringAllowed: false, dailyCallLimit, reviewedBy: 'test' }).onConflictDoUpdate({ target: t.adapterConfigs.sourceId, set: { enabled: true, implementation: 'ticketmaster_discovery', dailyCallLimit } });
}

const concierge = (h: DbHandle, fetchImpl: typeof fetch, envOver: Record<string, string> = {}) =>
  new Concierge({ db: h.db, env: discoveryEnv(envOver), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: null, fixtureOffers: FIXTURE_OFFERS, discoveryFetch: fetchImpl });

describe('reading a Discovery event', () => {
  it('keeps performers, venue, timezone, start instant, status and classification, and drops price ranges', () => {
    const e = parseDiscoveryEvent(NYR_HOME)!;
    expect(e.attractions.map((a) => a.name)).toEqual(['New York Rangers', 'New Jersey Devils']);
    expect(e.venue?.timezone).toBe('America/New_York');
    expect(e.startAt).toBe('2026-10-20T23:00:00Z');
    expect(e.statusCode).toBe('onsale');
    expect(e.genre).toBe('Hockey');
    expect(JSON.stringify(e)).not.toContain('priceRanges');
  });

  it('maps classifications onto the routing keys the source plan understands', () => {
    expect(categoryFor({ segment: 'Sports', genre: 'Hockey', subGenre: 'NHL', name: 'x' })).toBe('nhl');
    expect(categoryFor({ segment: 'Sports', genre: 'Basketball', subGenre: 'NBA', name: 'x' })).toBe('nba');
    expect(categoryFor({ segment: 'Sports', genre: 'Basketball', subGenre: 'WNBA', name: 'x' })).toBe('wnba');
    expect(categoryFor({ segment: 'Sports', genre: 'Baseball', subGenre: 'MLB', name: 'x' })).toBe('mlb');
    expect(categoryFor({ segment: 'Sports', genre: 'Hockey', subGenre: 'AHL', name: 'x' })).toBe('minor_league');
    expect(categoryFor({ segment: 'Music', genre: 'Pop', subGenre: 'Pop', name: 'Dua Lipa' })).toBe('concert');
    expect(categoryFor({ segment: 'Arts & Theatre', genre: 'Theatre', subGenre: 'Musical', name: 'Hamilton (Broadway)' })).toBe('broadway');
    expect(categoryFor({ segment: 'Arts & Theatre', genre: 'Comedy', subGenre: 'Comedy', name: 'x' })).toBe('comedy');
  });

  it('tags what is not an admission and reads sale status', () => {
    expect(subtypeFor({ name: 'New York Rangers Parking', timeTba: false })).toBe('parking');
    expect(subtypeFor({ name: 'Rangers VIP Package', timeTba: false })).toBe('package');
    expect(subtypeFor({ name: 'Rangers vs. Devils', timeTba: true })).toBe('time_tba');
    expect(subtypeFor({ name: 'Rangers vs. Devils', timeTba: false })).toBeNull();
    expect(statusFor('cancelled')).toBe('cancelled');
    expect(statusFor('postponed')).toBe('postponed');
    expect(statusFor('onsale')).toBe('scheduled');
  });

  it('reads home and away from the name and derives a team nickname', () => {
    expect(parseMatchup('New York Rangers vs. New Jersey Devils')).toEqual({ first: 'New York Rangers', second: 'New Jersey Devils', homeIs: 'first' });
    expect(parseMatchup('New York Rangers at New Jersey Devils')).toEqual({ first: 'New York Rangers', second: 'New Jersey Devils', homeIs: 'second' });
    expect(parseMatchup('Dua Lipa')).toBeNull();
    expect(teamAliases('New York Rangers')).toEqual(['Rangers']);
    expect(teamAliases('Dua Lipa')).toEqual(['Lipa']); // harmless for a performer: performers do not get aliases in the sync
  });

  it('turns a TBA local date into a comparable instant in the venue zone', () => {
    // 19:00 in New York in October is 23:00Z (EDT).
    expect(localToInstant('2026-10-20', '19:00', 'America/New_York').toISOString()).toBe('2026-10-20T23:00:00.000Z');
    // ...and in January it is 00:00Z the next day (EST).
    expect(localToInstant('2027-01-20', '19:00', 'America/New_York').toISOString()).toBe('2027-01-21T00:00:00.000Z');
  });
});

describe('syncing the catalog', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('creates venue, teams, event and mapping once, and a second sync updates rather than duplicates', async () => {
    const adapter = new TicketmasterDiscoveryAdapter('k', true, fakeFetch({ devils: [DEVILS_HOME] }));
    const first = await syncFromDiscovery(h.db, adapter, { keyword: 'Devils', trigger: 'manual', now: FIXTURE_NOW });
    expect(first.status).toBe('success');
    expect(first.eventsUpserted).toBe(1);

    const venues = await h.db.select().from(t.venues).where(eq(t.venues.name, 'Prudential Center'));
    expect(venues).toHaveLength(1);
    expect(venues[0]!.externalIds).toEqual({ ticketmaster: 'KovZpZAdE7' });
    expect(venues[0]!.timezone).toBe('America/New_York');

    const devils = await h.db.select().from(t.entities).where(eq(t.entities.slug, 'new-jersey-devils'));
    expect(devils).toHaveLength(1);
    expect(devils[0]!.aliases).toContain('Devils');
    expect(devils[0]!.league).toBe('NHL');

    // The Rangers already existed from the fixture seed: the sync attached the provider id instead of creating a twin.
    const rangers = await h.db.select().from(t.entities).where(eq(t.entities.slug, 'new-york-rangers'));
    expect(rangers).toHaveLength(1);
    expect(rangers[0]!.externalIds.ticketmaster).toBe('K8vZ9171o-7');

    const mapped = await h.db.select({ e: t.events, m: t.eventSourceMappings }).from(t.eventSourceMappings).innerJoin(t.events, eq(t.events.id, t.eventSourceMappings.eventId)).where(and(eq(t.eventSourceMappings.sourceId, 'ticketmaster'), eq(t.eventSourceMappings.sourceEventId, 'tm-devils-1')));
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.e.category).toBe('nhl');
    expect(mapped[0]!.e.primaryEntityId).toBe(devils[0]!.id); // the keyword named the Devils
    expect(mapped[0]!.e.isHome).toBe(true); // "Devils vs. Rangers": first is home
    expect(mapped[0]!.e.verifiedSourceId).toBe('ticketmaster');
    expect(mapped[0]!.m.authoritativeUrl).toContain('/event/tm-devils-1');

    const second = await syncFromDiscovery(h.db, adapter, { keyword: 'Devils', trigger: 'manual', now: FIXTURE_NOW, force: true });
    expect(second.status).toBe('success');
    expect(await h.db.select().from(t.events).where(eq(t.events.name, 'New Jersey Devils vs. New York Rangers'))).toHaveLength(1);
    expect(await h.db.select().from(t.venues).where(eq(t.venues.name, 'Prudential Center'))).toHaveLength(1);
  });

  it('does not ask the provider the same question twice inside the freshness window, and counts only real calls', async () => {
    let calls = 0;
    const adapter = new TicketmasterDiscoveryAdapter('k', true, (async (u: string | URL | Request) => {
      calls += 1;
      return fakeFetch({ islanders: [] })(u);
    }) as typeof fetch);
    const a = await syncFromDiscovery(h.db, adapter, { keyword: 'Islanders', trigger: 'interpret', now: FIXTURE_NOW });
    const b = await syncFromDiscovery(h.db, adapter, { keyword: 'islanders', trigger: 'interpret', now: new Date(FIXTURE_NOW.getTime() + 60 * 60_000) });
    expect(a.status).toBe('success');
    expect(b.status).toBe('skipped_fresh');
    expect(calls).toBe(1);
    const c = await syncFromDiscovery(h.db, adapter, { keyword: 'islanders', trigger: 'interpret', now: new Date(FIXTURE_NOW.getTime() + 7 * 3_600_000) });
    expect(c.status).toBe('success');
    expect(calls).toBe(2);
  });

  it('stops at the daily call budget without touching the provider', async () => {
    let calls = 0;
    const adapter = new TicketmasterDiscoveryAdapter('k', true, (async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    const before = await callsToday(h.db, FIXTURE_NOW);
    const r = await syncFromDiscovery(h.db, adapter, { keyword: 'Something New', trigger: 'interpret', now: FIXTURE_NOW, dailyCallLimit: before });
    expect(r.status).toBe('skipped_budget');
    expect(calls).toBe(0);
  });

  it('records provider trouble and reports it instead of throwing', async () => {
    const limited = new TicketmasterDiscoveryAdapter('k', true, (async () => new Response('', { status: 429 })) as typeof fetch);
    expect((await syncFromDiscovery(h.db, limited, { keyword: 'Rate Limited Team', trigger: 'interpret', now: FIXTURE_NOW })).status).toBe('rate_limited');
    const down = new TicketmasterDiscoveryAdapter('k', true, (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch);
    expect((await syncFromDiscovery(h.db, down, { keyword: 'Unreachable Team', trigger: 'interpret', now: FIXTURE_NOW })).status).toBe('timeout');
    const rows = await h.db.select().from(t.catalogSyncs).where(eq(t.catalogSyncs.keywordNormalized, 'rate limited team'));
    expect(rows[0]?.status).toBe('rate_limited');
  });

  it('skips non-US venues and events without a placeable date or venue', async () => {
    const abroad = tmEvent({ id: 'tm-tor-1', name: 'Toronto Maple Leafs vs. Montreal Canadiens', venue: { id: 'KovZtor', name: 'Scotiabank Arena', city: 'Toronto', state: 'ON', country: 'CA', tz: 'America/Toronto' }, attractions: [{ id: 'K8tor', name: 'Toronto Maple Leafs' }] });
    const noVenue = { ...tmEvent({ id: 'tm-novenue', name: 'Mystery Show' }), _embedded: {} };
    const adapter = new TicketmasterDiscoveryAdapter('k', true, fakeFetch({ leafs: [abroad, noVenue] }));
    const r = await syncFromDiscovery(h.db, adapter, { keyword: 'Leafs', trigger: 'manual', now: FIXTURE_NOW });
    expect(r.eventsSeen).toBe(2);
    expect(r.eventsUpserted).toBe(0);
  });
});

describe('resolving an event through discovery', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await enableDiscoveryAdapter(h);
  });
  afterAll(async () => {
    await h.close();
  });
  const ctx = { receivedAt: FIXTURE_NOW, venueTimeZone: 'America/New_York' };

  it('a team not on file resolves after one provider call, and the customer is told what was found', async () => {
    const c = concierge(h, fakeFetch({ devils: [DEVILS_HOME] }));
    const r = await c.resolveEventWithDiscovery(brief({ performerOrTeam: 'Devils', resolvedLocalDate: '2026-10-20' }), ctx);
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') {
      expect(r.event.name).toBe('New Jersey Devils vs. New York Rangers');
      expect(r.venue.name).toBe('Prudential Center');
      expect(r.entityKind).toBe('team');
    }
    const synced = await h.db.select().from(t.catalogSyncs).where(eq(t.catalogSyncs.keywordNormalized, 'devils'));
    expect(synced[0]?.trigger).toBe('interpret');
  });

  it('a name the provider also has nothing for is reported as checked, not merely absent', async () => {
    const c = concierge(h, fakeFetch({ 'nobody famous': [] }));
    const r = await c.resolveEventWithDiscovery(brief({ performerOrTeam: 'Nobody Famous' }), ctx);
    expect(r).toEqual({ kind: 'no_match', reason: 'discovery_no_results' });
  });

  it('without an enabled adapter row the provider is never called, even with a key', async () => {
    let calls = 0;
    await h.db.update(t.adapterConfigs).set({ enabled: false }).where(eq(t.adapterConfigs.sourceId, DISCOVERY_SOURCE_ID));
    try {
      const c = concierge(h, (async () => {
        calls += 1;
        return new Response('{}');
      }) as typeof fetch);
      const r = await c.resolveEventWithDiscovery(brief({ performerOrTeam: 'Unknown Band' }), ctx);
      expect(r).toEqual({ kind: 'no_match', reason: 'unknown_performer' });
      expect(calls).toBe(0);
    } finally {
      await h.db.update(t.adapterConfigs).set({ enabled: true }).where(eq(t.adapterConfigs.sourceId, DISCOVERY_SOURCE_ID));
    }
  });

  it('two teams sharing a nickname on the same night is a choice, and a city settles it', async () => {
    const c = concierge(h, fakeFetch({ rangers: [NYR_HOME, TEX_HOME] }));
    const open = await c.resolveEventWithDiscovery(brief({ performerOrTeam: 'rangers', resolvedLocalDate: '2026-10-20' }), ctx);
    expect(open.kind).toBe('ambiguous');
    if (open.kind === 'ambiguous') {
      expect(open.candidates.map((x) => x.label).join(' | ')).toMatch(/New York Rangers \(NHL\)/);
      expect(open.candidates.map((x) => x.label).join(' | ')).toMatch(/Texas Rangers \(MLB\)/);
    }
    const settled = await c.resolveEventWithDiscovery(brief({ performerOrTeam: 'rangers', resolvedLocalDate: '2026-10-20', city: 'New York' }), ctx);
    expect(settled.kind).toBe('resolved');
    if (settled.kind === 'resolved') expect(settled.event.name).toBe('New York Rangers vs. New Jersey Devils');
  });

  it('cancelled games and parking are never what "tickets to the game" means', async () => {
    const cancelled = tmEvent({ id: 'tm-nets-cx', name: 'Brooklyn Nets vs. Boston Celtics', status: 'cancelled', genre: 'Basketball', subGenre: 'NBA', venue: { id: 'KovZbk', name: 'Barclays Center', city: 'Brooklyn', state: 'NY', tz: 'America/New_York' }, attractions: [{ id: 'K8nets', name: 'Brooklyn Nets', genre: 'Basketball', subGenre: 'NBA' }] });
    const parking = tmEvent({ id: 'tm-nets-pk', name: 'Brooklyn Nets vs. Boston Celtics Parking', genre: 'Basketball', subGenre: 'NBA', venue: { id: 'KovZbk', name: 'Barclays Center', city: 'Brooklyn', state: 'NY', tz: 'America/New_York' }, attractions: [{ id: 'K8nets', name: 'Brooklyn Nets', genre: 'Basketball', subGenre: 'NBA' }] });
    const c = concierge(h, fakeFetch({ nets: [cancelled, parking] }));
    const r = await c.resolveEventWithDiscovery(brief({ performerOrTeam: 'Nets', resolvedLocalDate: '2026-10-20' }), ctx);
    expect(r).toEqual({ kind: 'no_match', reason: 'discovery_no_results' });
    const parkingRow = await h.db.select().from(t.events).where(eq(t.events.name, 'Brooklyn Nets vs. Boston Celtics Parking'));
    expect(parkingRow[0]?.subtype).toBe('parking'); // kept on file, tagged, just not an answer
  });

  it('a time-to-be-announced game still resolves by its date', async () => {
    const tba = tmEvent({ id: 'tm-mets-tba', name: 'New York Mets vs. Atlanta Braves', dateTime: null, localDate: '2026-10-22', timeTBA: true, genre: 'Baseball', subGenre: 'MLB', venue: { id: 'KovZciti', name: 'Citi Field', city: 'Flushing', state: 'NY', tz: 'America/New_York' }, attractions: [{ id: 'K8mets', name: 'New York Mets', genre: 'Baseball', subGenre: 'MLB' }] });
    const c = concierge(h, fakeFetch({ mets: [tba] }));
    const r = await c.resolveEventWithDiscovery(brief({ performerOrTeam: 'Mets', resolvedLocalDate: '2026-10-22' }), ctx);
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.event.subtype).toBe('time_tba');
  });

  it('provider failure at request time falls back to the honest local answer', async () => {
    const c = concierge(h, (async () => new Response('', { status: 503 })) as typeof fetch);
    const r = await c.resolveEventWithDiscovery(brief({ performerOrTeam: 'Sabres' }), ctx);
    expect(r).toEqual({ kind: 'no_match', reason: 'unknown_performer' });
  });

  it("asks the provider about the customer's date window, not the whole future", async () => {
    let seen = '';
    const c = concierge(h, (async (u: string | URL | Request) => {
      seen = String(u);
      return new Response(JSON.stringify({ _embedded: { events: [] } }));
    }) as typeof fetch);
    await c.resolveEventWithDiscovery(brief({ performerOrTeam: 'Sharks', dateExpression: 'in November' }), { receivedAt: FIXTURE_NOW, venueTimeZone: null });
    const p = new URL(seen).searchParams;
    expect(p.get('startDateTime')).toBe('2026-10-31T00:00:00Z');
    expect(p.get('endDateTime')).toBe('2026-12-01T23:59:59Z');
    expect(p.get('countryCode')).toBe('US');
  });
});

describe('catalog pre-warm', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('does nothing until the adapter row is enabled, then syncs each seed name', async () => {
    const env = discoveryEnv({ CATALOG_SEED_KEYWORDS: 'new jersey devils,new york rangers' });
    const off = await prewarmCatalog(h.db, env, { now: FIXTURE_NOW, fetchImpl: fakeFetch({}) });
    expect(off).toEqual({ ran: false, reason: 'adapter_not_enabled', results: [] });

    await enableDiscoveryAdapter(h);
    const on = await prewarmCatalog(h.db, env, { now: FIXTURE_NOW, fetchImpl: fakeFetch({ 'new jersey devils': [DEVILS_HOME], 'new york rangers': [NYR_HOME] }) });
    expect(on.ran).toBe(true);
    expect(on.results.map((r) => [r.keyword, r.status, r.eventsUpserted])).toEqual([
      ['new jersey devils', 'success', 1],
      ['new york rangers', 'success', 1],
    ]);
  });
});

describe('manual research links', () => {
  it('uses the official event page where discovery mapped one, and a search link elsewhere', () => {
    const links = researchLinksFor({ sourceIds: ['ticketmaster', 'seatgeek', 'stubhub', 'not-a-source'], eventName: 'New York Rangers vs. New Jersey Devils', localDate: '2026-10-20', officialUrls: { ticketmaster: 'https://www.ticketmaster.com/event/tm-nyr-1' } });
    expect(links.map((l) => l.sourceId)).toEqual(['ticketmaster', 'seatgeek', 'stubhub']);
    expect(links[0]).toMatchObject({ kind: 'official_event_page', url: 'https://www.ticketmaster.com/event/tm-nyr-1' });
    expect(links[1]!.kind).toBe('search');
    expect(links[1]!.url).toContain('seatgeek.com/search?search=New%20York%20Rangers');
    expect(links[1]!.url).toContain('2026-10-20');
  });
});
