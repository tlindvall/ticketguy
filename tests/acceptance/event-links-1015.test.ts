import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, testEnv } from '../harness';
import { idsFromSeatData, marketplaceEventPage, marketplaceLinks, resolveMarketplaceIds, storedMarketplaceIds, withoutTracking, type MarketplaceEventLookup } from '@/lib/market/event-links';
import { stubhubCatalogLookup } from '@/lib/market/stubhub-catalog';
import { MarketTracker } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { toMarketListing } from '@/lib/market/alternatives';
import { pickLinksFor } from '@/lib/intake/pipeline';
import { perEmail } from '../../evals/scorers';
import type { Scenario, TurnOut } from '../../evals/harness';

/**
 * Recommendation emails linked a search for a game we had already identified (Rangers vs Canadiens at MSG, Nov 16 2026:
 * StubHub event 161415584, Vivid Seats production 7301115). Each marketplace's event id is now resolved once per game
 * and kept in event_source_mappings: SeatData's fields first, then the marketplace's own catalog. The links are the
 * event pages, with no tracking parameters; a search only when no id resolves.
 */
const ARENA = '10000000-0000-4000-8000-0000000e1015';
const TEAM = '20000000-0000-4000-8000-0000000e1015';
const GAME = '30000000-0000-4000-8000-0000000e1015';
const OTHER = '30000000-0000-4000-8000-0000000f1015';

describe('marketplace event links', () => {
  let h: DbHandle;
  const now = new Date('2026-10-15T15:00:00Z');
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Madison Square Garden', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'New York Rangers', slug: 'link-rangers', aliases: [], league: 'NHL', homeVenueId: ARENA });
    const game = (id: string, start: string, name: string) => ({ id, name, category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date(start), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
    await h.db.insert(t.events).values([game(GAME, '2026-11-17T00:00:00Z', 'Montreal Canadiens at New York Rangers'), game(OTHER, '2026-11-20T00:00:00Z', 'Boston Bruins at New York Rangers')]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('builds the event pages for the Nov 16 game, and a search only without an id', () => {
    const l = marketplaceLinks({ stubhub: '161415584', vividseats: '7301115' }, { eventName: 'Montreal Canadiens at New York Rangers', quantity: 2, noun: 'game' });
    expect(l.stubhub).toEqual({ label: 'Event page on StubHub', url: 'https://www.stubhub.com/event/161415584/?quantity=2', eventPage: true });
    expect(l.vividseats).toEqual({ label: 'Event page on Vivid Seats', url: 'https://www.vividseats.com/production/7301115', eventPage: true });
    const none = marketplaceLinks(null, { eventName: 'Montreal Canadiens at New York Rangers', quantity: 2, noun: 'game' });
    expect(none.stubhub.url).toBe('https://www.stubhub.com/search?q=Montreal%20Canadiens%20at%20New%20York%20Rangers');
    expect(none.vividseats.label).toBe('Search Vivid Seats for this game');
  });

  it('never carries tracking parameters: qid, iid, ut, lat/lg', () => {
    expect(withoutTracking('https://www.stubhub.com/event/161415584/?quantity=2&qid=abc&iid=9&ut=x1&lat=40.75&lg=-73.99')).toBe('https://www.stubhub.com/event/161415584/?quantity=2');
    expect(withoutTracking('https://www.vividseats.com/production/7301115?utm_source=x&gclid=y')).toBe('https://www.vividseats.com/production/7301115');
    // The feed's own listing link is cleaned when it's read.
    expect(toMarketListing({ price: 120, quantity: 2, url: 'https://www.stubhub.com/event/161415584/?listingId=55&qid=q1&lat=1&lg=2' })!.url).toBe('https://www.stubhub.com/event/161415584/?listingId=55');
    expect(pickLinksFor({ priceCents: 1, quantity: 2, section: '214', row: '3', zone: null, marketplace: 'stubhub', url: 'https://www.stubhub.com/event/161415584/?listingId=55&iid=7' }, 'x', 2, null)[0]!.url).toBe('https://www.stubhub.com/event/161415584/?listingId=55');
  });

  it('reads the ids SeatData names, in its fields or its rows’ page links', () => {
    expect(marketplaceEventPage('https://www.stubhub.com/new-york-rangers-tickets-11-16-2026/event/161415584/?quantity=2')).toEqual({ marketplace: 'stubhub', id: '161415584' });
    expect(marketplaceEventPage('https://www.vividseats.com/new-york-rangers-tickets-madison-square-garden-11-16-2026--sports-nhl-hockey/production/7301115')).toEqual({ marketplace: 'vividseats', id: '7301115' });
    expect(marketplaceEventPage('https://www.stubhub.com/search?q=rangers')).toBeNull();
    expect(idsFromSeatData({ event_id_sh: 161415584 }, { url: 'https://www.vividseats.com/x/production/7301115' })).toEqual({ stubhub: '161415584', vividseats: '7301115' });
    expect(idsFromSeatData({ vs_production_id: '7301115', event_id_sh: 'n/a' })).toEqual({ stubhub: null, vividseats: '7301115' });
  });

  it('resolves once: SeatData first, the catalog only for what is missing, then kept for the game', async () => {
    const asked: string[] = [];
    const vivid: MarketplaceEventLookup = { marketplace: 'vividseats', find: async (q) => { asked.push(`vivid:${q.localDate}`); return '7301115'; } };
    const stub: MarketplaceEventLookup = { marketplace: 'stubhub', find: async () => { asked.push('stubhub'); return '999999999'; } };
    const a = { eventId: GAME, name: 'New York Rangers', venue: 'Madison Square Garden', city: 'New York', localDate: '2026-11-16', now };
    const ids = await resolveMarketplaceIds(h.db, { ...a, seatData: { stubhub: '161415584' }, lookups: [stub, vivid] });
    expect(ids).toEqual({ stubhub: '161415584', vividseats: '7301115' });
    expect(asked).toEqual(['vivid:2026-11-16']);
    const rows = await h.db.select().from(t.eventSourceMappings).where(eq(t.eventSourceMappings.eventId, GAME));
    expect(rows.map((r) => [r.sourceId, r.sourceEventId, r.role, r.confidence]).sort()).toEqual([['stubhub', '161415584', 'marketplace', 'provider'], ['vividseats', '7301115', 'marketplace', 'verified']]);
    // Next reply: from storage, no lookup at all.
    asked.length = 0;
    expect(await resolveMarketplaceIds(h.db, { ...a, lookups: [stub, vivid] })).toEqual(ids);
    expect(asked).toEqual([]);
  });

  it('a lookup that fails or finds nothing leaves the search; a customer’s link is used, never kept', async () => {
    const failing: MarketplaceEventLookup = { marketplace: 'vividseats', find: async () => { throw new Error('403'); } };
    const ids = await resolveMarketplaceIds(h.db, { eventId: OTHER, name: 'New York Rangers', venue: 'Madison Square Garden', city: 'New York', localDate: '2026-11-19', fromLink: { stubhub: '158000001' }, lookups: [failing], now });
    expect(ids).toEqual({ stubhub: '158000001', vividseats: null });
    expect(await storedMarketplaceIds(h.db, OTHER)).toEqual({ stubhub: null, vividseats: null });
    expect(marketplaceLinks(ids, { eventName: 'x', quantity: 2 }).vividseats.eventPage).toBe(false);
  });

  it('an id another game already holds is never moved to this one', async () => {
    const ids = await resolveMarketplaceIds(h.db, { eventId: OTHER, name: 'x', venue: 'y', city: null, localDate: '2026-11-19', seatData: { stubhub: '161415584' }, now });
    expect(ids.stubhub).toBeNull();
    expect((await storedMarketplaceIds(h.db, GAME)).stubhub).toBe('161415584');
  });

  it('StubHub’s catalog: the game at that venue on that date, from its id or its page link', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      calls.push(new URL(input).pathname);
      if (input.includes('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ _embedded: { items: [
        { id: 161400000, name: 'Rangers at Devils', start_date: '2026-11-16T19:00:00-05:00', _embedded: { venue: { name: 'Prudential Center' } } },
        { name: 'Canadiens at Rangers', start_date: '2026-11-16T19:00:00-05:00', _embedded: { venue: { name: 'Madison Square Garden' } }, _links: { 'event:webpage': { href: 'https://www.stubhub.com/new-york-rangers-tickets-11-16-2026/event/161415584/' } } },
      ] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = stubhubCatalogLookup({ clientId: 'id', clientSecret: 'secret' }, fetchImpl);
    expect(await lookup.find({ name: 'New York Rangers', venue: 'Madison Square Garden', city: 'New York', localDate: '2026-11-16' })).toBe('161415584');
    expect(await lookup.find({ name: 'New York Rangers', venue: 'Madison Square Garden', city: 'New York', localDate: '2026-11-17' })).toBeNull();
    expect(calls.filter((c) => c === '/oauth2/token')).toHaveLength(1);
    // Off unless enabled with both credentials.
    expect(() => testEnv({ STUBHUB_CATALOG_ENABLED: 'true' })).toThrow(/STUBHUB_CLIENT_ID and STUBHUB_CLIENT_SECRET/);
  });

  it('SeatData’s match names the marketplace ids, and they are kept for the game', async () => {
    const GAME3 = '30000000-0000-4000-8000-000000031015';
    await h.db.insert(t.events).values({ id: GAME3, name: 'Islanders at Rangers', category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-11-25T00:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME3, sourceId: 'ticketmaster', sourceEventId: 'TMLINKS3', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMLINKS3', role: 'discovery', confidence: 'provider_id' });
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking'] }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    await h.db.insert(t.trackedEvents).values({ eventId: GAME3, provider: 'seatdata', reasons: ['cohort'], nextPollAt: now });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const fetchImpl = (async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/v1/events/search') return json({ data: url.searchParams.get('tm_event_id') === 'TMLINKS3' ? [{ event_id: 4242, event_name: 'Islanders at Rangers', event_date: '2026-11-24', venue_name: 'Madison Square Garden', venue_city: 'New York', venue_state: 'NY', event_id_sh: 161500000, event_id_vs: 7309999 }] : [], has_more: false, next_cursor: null });
      if (url.pathname.endsWith('/stats') || url.pathname.endsWith('/sales')) return json({ data: [], has_more: false, next_cursor: null });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    await new MarketTracker({ db: h.db, env: testEnv({ SEATDATA_API_KEY: 'ab'.repeat(32), MARKET_TRACK_ENTITIES: 'link-rangers' }), now: () => now, fetchImpl, sleep: async () => {} }).run();
    expect(await storedMarketplaceIds(h.db, GAME3)).toEqual({ stubhub: '161500000', vividseats: '7309999' });
    const [tr] = await h.db.select().from(t.trackedEvents).where(and(eq(t.trackedEvents.eventId, GAME3)));
    expect(tr!.providerEventId).toBe('4242');
  });

  it('links_grounded counts a stored game’s event page as grounded, and nothing with a tracking parameter', () => {
    const scorer = perEmail.find((f) => f.name === 'links_grounded')!;
    const turn = (reply: string): TurnOut => ({ step: 1, customer: 'x', at: now.toISOString(), reply, emails: [], state: null, eventId: null, brief: null, newRecommendations: 0, watches: [], alertsRaised: 0, marketplaceEvents: ['stubhub:161415584', 'vividseats:7301115'] });
    const input = { id: 't', steps: [] } as unknown as Scenario;
    const score = (reply: string) => (scorer as unknown as (a: { input: Scenario; output: TurnOut[] }) => { score: number }).call(null, { input, output: [turn(reply)] }).score;
    expect(score('Event page on StubHub: https://www.stubhub.com/event/161415584/?quantity=2')).toBe(1);
    expect(score('Event page on Vivid Seats: https://www.vividseats.com/production/7301115')).toBe(1);
    expect(score('https://www.stubhub.com/event/161415584/?quantity=2&qid=abc')).toBe(0);
    expect(score('https://www.vividseats.com/production/7000000')).toBe(0);
  });
});
