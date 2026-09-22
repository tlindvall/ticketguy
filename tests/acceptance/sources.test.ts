import { describe, expect, it } from 'vitest';
import { loadRegistry, sourceIdForHost } from '@/lib/sources/registry';
import { validateRouting, CATEGORY_ROUTES, sourcePlan, CORE, EXTENDED } from '@/lib/sources/routing';
import { FixtureAdapter, NotIntegratedAdapter, TicketmasterDiscoveryAdapter, buildAdapter } from '@/lib/sources/adapters';
import { fixtureOffer, FIXTURE_EVENT_ID } from '../fixtures/offers';

describe('registry and routing', () => {
  it('loads 135 not-integrated sources and validates all 29 routes', () => {
    const r = loadRegistry();
    expect(r.sources).toHaveLength(135);
    expect(r.sources.every((s) => s.integration_status === 'not_integrated' && s.access_rights === 'not_validated')).toBe(true);
    expect(() => validateRouting()).not.toThrow();
    expect(CATEGORY_ROUTES).toHaveLength(29);
    expect(CORE).toHaveLength(7);
    expect(EXTENDED).toHaveLength(16);
    const nhl = sourcePlan('nhl');
    expect(nhl.required).toEqual(expect.arrayContaining(['nhl-ticket-exchange', ...CORE, ...EXTENDED]));
    expect(sourcePlan('unknown-category').required).toEqual([]);
  });
  it('maps alias domains to registry ids', () => {
    expect(sourceIdForHost('www.seetickets.us')).toBe('eventim-us-see-tickets-us');
    expect(sourceIdForHost('www.stubhub.com')).toBe('stubhub');
    expect(sourceIdForHost('evil.example')).toBeNull();
  });
});

describe('A11/A12/A13 adapter statuses', () => {
  const input = { requestId: 'r', revision: 1, eventId: FIXTURE_EVENT_ID, providerEventId: null, quantity: 2, hardConstraints: {} };
  it('not-integrated and disabled adapters report their status and never synthesize offers', async () => {
    const r = await new NotIntegratedAdapter('stubhub').search(input);
    expect(r.status).toBe('not_integrated');
    expect(r.offers).toEqual([]);
    const disabledFixture = buildAdapter({ sourceId: 'fixture-source', implementation: 'fixture', enabled: false, accessApprovalEvidence: null, monitoringAllowed: false }, { fixtureOffers: { [FIXTURE_EVENT_ID]: [fixtureOffer()] }, ticketmasterKey: null, ticketmasterEnabled: false });
    expect((await disabledFixture.search(input)).status).toBe('not_integrated');
  });
  it('timeouts / blocks / rate limits keep their status (never "sold out")', async () => {
    for (const status of ['timeout', 'blocked', 'rate_limited', 'budget_exhausted'] as const) {
      const a = new FixtureAdapter('fixture-source', {}, { status, retryAfterSeconds: 30 });
      const r = await a.search(input);
      expect(r.status).toBe(status);
      expect(r.offers).toEqual([]);
      expect(r.coverageNotes.join(' ')).toContain('not sold out');
    }
  });
  it('fixture offers are always marked fixture', async () => {
    const a = new FixtureAdapter('fixture-source', { [FIXTURE_EVENT_ID]: [fixtureOffer({ collectionMode: 'approved_api' as never })] });
    const r = await a.search(input);
    expect(r.offers[0]!.collectionMode).toBe('fixture');
  });
  it('Ticketmaster Discovery never produces purchasable offers and is gated by key + enablement', async () => {
    const off = new TicketmasterDiscoveryAdapter('key', false);
    expect((await off.discoverEvents({ keyword: 'x' })).status).toBe('access_not_approved');
    const noKey = new TicketmasterDiscoveryAdapter(null, true);
    expect((await noKey.discoverEvents({ keyword: 'x' })).status).toBe('not_configured');
    const on = new TicketmasterDiscoveryAdapter('key', true, (async () => new Response(JSON.stringify({ _embedded: { events: [{ id: 'tm1', name: 'Fixture Show', url: 'https://www.ticketmaster.com/e/tm1', priceRanges: [{ min: 20, max: 500 }], dates: { start: { localDate: '2026-10-10' }, timezone: 'America/New_York' } }] } }), { status: 200 })) as typeof fetch);
    const d = await on.discoverEvents({ keyword: 'Fixture Show' });
    expect(d.status).toBe('success');
    expect(d.events[0]).not.toHaveProperty('priceRanges');
    expect((await on.search(input)).status).toBe('not_supported');
    expect((await on.search(input)).offers).toEqual([]);
  });
});
