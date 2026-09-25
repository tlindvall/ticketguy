import { describe, expect, it } from 'vitest';
import { accessClassFor, accessProfileFor, accessSummary, ACCESS_CLASS_META } from '@/lib/sources/access';
import { loadRegistry } from '@/lib/sources/registry';
import { CORE, EXTENDED, CATEGORY_ROUTES } from '@/lib/sources/routing';
import { researchLinksFor } from '@/lib/catalog/research-links';

/**
 * The registry says "not_integrated" 135 times. This is the classification that says what each one could
 * ever become, so the sources page and the partner plan stop presenting routing pages and discount rules
 * as an adapter backlog.
 */
describe('source access classes', () => {
  const sources = loadRegistry().sources;

  it('classifies every registry source and the summary adds up to the registry', () => {
    const summary = accessSummary(sources);
    expect(summary.reduce((n, c) => n + c.count, 0)).toBe(sources.length);
    for (const s of sources) expect(Object.keys(ACCESS_CLASS_META)).toContain(accessClassFor(s));
  });

  it('only sources with a documented programme are automatable, and each of those has somewhere to apply', () => {
    const automatable = sources.filter((s) => accessProfileFor(s).automatable);
    expect(automatable.map((s) => s.id).sort()).toEqual(['seatgeek', 'stubhub', 'stubhub-api', 'ticket-evolution', 'ticketmaster', 'ticketmaster-partner-api', 'ticketnetwork']);
    for (const s of automatable) expect(accessProfileFor(s).programmeUrl).toMatch(/^https:\/\//);
    expect(accessClassFor({ id: 'ticketmaster', source_type: 'Hybrid', routing_tier: 'core' })).toBe('catalog_api');
  });

  it('every core and extended comparison seller is a listings source, with or without an API', () => {
    for (const id of [...CORE, ...EXTENDED]) {
      const s = sources.find((x) => x.id === id)!;
      expect(['catalog_api', 'listing_api_partner', 'listing_no_api']).toContain(accessClassFor(s));
    }
    expect(accessClassFor(sources.find((s) => s.id === 'vivid-seats')!)).toBe('listing_no_api');
    expect(accessClassFor(sources.find((s) => s.id === 'cashortrade')!)).toBe('listing_no_api');
  });

  it("every route's official-start authority is a routing reference or a seller, never a context rule", () => {
    for (const r of CATEGORY_ROUTES) {
      for (const id of r.officialStart) {
        const cls = accessClassFor(sources.find((s) => s.id === id)!);
        expect(['routing_reference', 'catalog_api', 'listing_api_partner', 'primary_platform']).toContain(cls);
      }
    }
    expect(accessClassFor(sources.find((s) => s.id === 'nhl-ticket-exchange')!)).toBe('routing_reference');
  });

  it('discounts, lotteries, cardholder and eligibility programmes are context rules; venue engines are primary platforms', () => {
    for (const id of ['tkts-by-tdf', 'telecharge-lottery-rush', 'american-express-experiences', 'vet-tix', 'bandsintown']) expect(accessClassFor(sources.find((s) => s.id === id)!)).toBe('context_rule');
    for (const id of ['etix', 'dice', 'tessitura', 'paciolan-evenue', 'todaytix', 'telecharge']) expect(accessClassFor(sources.find((s) => s.id === id)!)).toBe('primary_platform');
  });

  it('research links carry the conditional sources after the required ones, each with its access class', () => {
    const links = researchLinksFor({ sourceIds: ['nhl-ticket-exchange', 'stubhub'], conditionalSourceIds: ['fevo', 'stubhub'], eventName: 'New York Rangers vs. New Jersey Devils', localDate: '2026-10-20', officialUrls: {} });
    expect(links.map((l) => [l.sourceId, l.role, l.access])).toEqual([
      ['nhl-ticket-exchange', 'required', 'routing_reference'],
      ['stubhub', 'required', 'listing_api_partner'],
      ['fevo', 'conditional', 'primary_platform'],
    ]);
  });
});
