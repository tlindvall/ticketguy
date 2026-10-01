import { describe, expect, it } from 'vitest';
import {
  DEPTH_RULES, EXTRA_POLICY_IDS, OPERATIONS, ROUTE_KEYS, allows, evaluateOperationCapability, eventFormat, isFoodDrink, operationsForClaims,
  outsideIntent, parseOverrides, policyCategory, resolveServicePolicy, type AdapterFacts, type ServiceDepth,
} from '@/lib/domain/service-depth';
import { CATEGORY_ROUTES, planSources } from '@/lib/sources/routing';
import { categoryFor } from '@/lib/catalog/sync';
import { compareOffers } from '@/lib/domain/comparison';
import { constraintBasket, meetsDelivery, readBasket } from '@/lib/domain/watches';
import type { Offer } from '@/lib/domain/types';

/**
 * The service-depth policy (DECISION_LOG #61), as pure functions: every route resolves on purpose, genre and
 * geography never stand in for format, unknown never becomes Core, and capability needs rights and coverage
 * as well as permission.
 */
const NOW = new Date('2026-10-01T15:00:00Z');
const BLOCKED = ['high_school', 'conventions', 'attractions', 'theme_parks', 'cinema'];
const resolve = (category: string | null, extra: Partial<Parameters<typeof resolveServicePolicy>[0]> = {}) => resolveServicePolicy({ category, blockedCategories: [], now: NOW, ...extra });

describe('SD01: every route and intent has a deliberate depth', () => {
  it('maps exactly the 29 routing keys, plus the new intents', () => {
    expect(ROUTE_KEYS).toHaveLength(29);
    expect([...ROUTE_KEYS].sort()).toEqual(CATEGORY_ROUTES.map((r) => r.key).sort());
    expect(Object.keys(DEPTH_RULES).sort()).toEqual([...ROUTE_KEYS, ...EXTRA_POLICY_IDS].sort());
  });

  it('gives each key a depth and a reason under every format', () => {
    for (const key of [...ROUTE_KEYS, 'food_drink', 'unknown']) {
      for (const format of ['touring', 'club', 'festival', 'local', 'unknown', null] as const) {
        const d = resolve(key, { format });
        expect(['core', 'compare', 'guide', 'outside']).toContain(d.depth);
        expect(d.reasons.length).toBeGreaterThan(0);
        expect(d.policyVersion).toBe('sd-1');
      }
    }
  });

  it('never makes an unknown category or an unknown concert format Core', () => {
    for (const format of ['touring', 'club', 'festival', 'local', 'unknown', null] as const) expect(resolve('unknown', { format }).depth).not.toBe('core');
    expect(resolve('a-category-added-next-year').depth).toBe('guide');
    expect(resolve('a-category-added-next-year').reasons).toContain('unknown_category');
    expect(resolve('concert', { format: 'unknown' }).depth).toBe('compare');
    expect(resolve('concert', { format: null }).depth).toBe('compare');
  });

  it('puts outside intents outside, with no operations at all', () => {
    for (const intent of ['classes_workshops', 'tours_experiences', 'participation_permits', 'travel_reservations', 'virtual_gambling'] as const) {
      const d = resolve(null, { outsideIntent: intent });
      expect(d.depth).toBe('outside');
      expect(d.allowedOperations).toEqual([]);
      expect(d.reasons).toEqual(['outside_product']);
    }
  });

  it('keeps operations strictly nested: Guide ⊂ Compare ⊂ Core, and only Core tracks, watches or trends', () => {
    const ops = (depth: ServiceDepth) => resolve(depth === 'core' ? 'nhl' : depth === 'compare' ? 'broadway' : 'classical').allowedOperations;
    expect(ops('core')).toEqual([...OPERATIONS]);
    for (const op of ops('guide')) expect(ops('compare')).toContain(op);
    for (const op of ops('compare')) expect(ops('core')).toContain(op);
    for (const op of ['market_tracking', 'price_watch', 'trend_advice', 'historical_context', 'staff_comparison'] as const) {
      expect(ops('compare')).not.toContain(op);
      expect(ops('guide')).not.toContain(op);
    }
    expect(ops('guide')).toEqual(['official_lookup', 'provided_offer_check']);
  });

  it('treats a non-US event as outside, and an operator block as the official route at most', () => {
    expect(resolve('nhl', { country: 'CA' }).depth).toBe('outside');
    expect(resolve('nhl', { country: 'CA' }).reasons).toContain('non_us_event');
    const blocked = resolveServicePolicy({ category: 'attractions', blockedCategories: BLOCKED, now: NOW });
    expect(blocked.reasons).toContain('operator_blocked');
    expect(blocked.allowedOperations).toEqual(['official_lookup']);
  });
});

describe('SD02/SD03: format, not genre or geography, sets concert depth', () => {
  it('an electronic act at an arena is a concert; the same act at a club is a club night', () => {
    const arena = eventFormat({ category: 'electronic_nightlife', name: 'Fred again..', venueName: 'Madison Square Garden' });
    const club = eventFormat({ category: 'electronic_nightlife', name: 'Fred again.. (DJ set)', venueName: 'Le Bain Club' });
    expect(arena).toBe('touring');
    expect(club).toBe('club');
    expect(resolve('electronic_nightlife', { format: arena }).depth).toBe('core');
    expect(resolve('electronic_nightlife', { format: club }).depth).toBe('guide');
    // A venue the heuristic can't place stays at the category's own depth, never above it.
    expect(resolve('electronic_nightlife', { format: eventFormat({ category: 'electronic_nightlife', name: 'Peggy Gou', venueName: 'Elsewhere' }) }).depth).toBe('guide');
  });

  it('gives equivalent touring concerts the same depth in New York, Nashville, Los Angeles and Honolulu', () => {
    const venues = ['Madison Square Garden', 'Bridgestone Arena', 'Crypto.com Arena', 'Neal S. Blaisdell Arena'];
    for (const name of ['Chris Stapleton', 'Dua Lipa', 'Foo Fighters']) {
      const depths = venues.map((v) => resolve('concert', { format: eventFormat({ category: 'concert', name, venueName: v }) }).depth);
      expect(new Set(depths)).toEqual(new Set(['core']));
    }
  });

  it('reads a small local gig as Guide and an open mic as local', () => {
    expect(resolve('concert', { format: eventFormat({ category: 'concert', name: 'Local Band', venueName: 'Pete’s Candy Store Bar' }) }).depth).toBe('guide');
    expect(eventFormat({ category: 'comedy', name: 'Tuesday Open Mic', venueName: 'The Stand' })).toBe('local');
  });

  it('stops the catalog filing unknown provider classifications as concerts', () => {
    expect(categoryFor({ segment: 'Undefined', genre: null, subGenre: null, name: 'Mystery Experience' })).toBe('unknown');
    expect(categoryFor({ segment: null, genre: null, subGenre: null, name: 'Something' })).toBe('unknown');
    expect(categoryFor({ segment: 'Miscellaneous', genre: 'Food & Drink', subGenre: null, name: 'Taco Fest' })).toBe('food_drink');
    // "Fest" alone isn't a festival; the word is.
    expect(categoryFor({ segment: 'Music', genre: 'Rock', subGenre: null, name: 'Metalfest Night' })).toBe('concert');
    expect(categoryFor({ segment: 'Music', genre: 'Rock', subGenre: null, name: 'Governors Ball Music Festival' })).toBe('festival');
    // The genre keeps its routing key; depth comes from the format.
    expect(categoryFor({ segment: 'Music', genre: 'Dance/Electronic', subGenre: null, name: 'Fred again..' })).toBe('electronic_nightlife');
    expect(policyCategory('unknown')).toBe('unknown');
  });
});

describe('outside intents and food/drink, from the customer’s words', () => {
  const none = { performerOrTeam: null };
  it('recognises classes, tours, permits, travel and online-only/betting', () => {
    expect(outsideIntent('2 tickets for a pasta-making class on Oct 5, $120 total', none)).toBe('classes_workshops');
    expect(outsideIntent('Can you get us on a guided tour of the city next Saturday?', none)).toBe('tours_experiences');
    expect(outsideIntent('I need a Half Dome permit for Oct 12, two people', none)).toBe('participation_permits');
    expect(outsideIntent('Can you get me a bib for the NYC Marathon?', none)).toBe('participation_permits');
    expect(outsideIntent('Book me a hotel near the Garden for Oct 3', none)).toBe('travel_reservations');
    expect(outsideIntent('Find cheap flights to Nashville for the weekend', none)).toBe('travel_reservations');
    expect(outsideIntent('Is there a livestream of the Taylor Swift show?', { performerOrTeam: 'Taylor Swift' })).toBe('virtual_gambling');
    expect(outsideIntent('Which sportsbook has the best parlays for the Knicks?', { performerOrTeam: 'Knicks' })).toBe('virtual_gambling');
  });

  it('leaves ordinary ticket requests alone', () => {
    for (const text of [
      'Two first class seats for Hamilton, please', 'Taylor Swift stadium tour, 2 tickets in Philly', 'Is the Hamilton lottery worth entering?',
      'My flight lands at 5 so I need something after 7pm', 'Best bet for 4 Rangers seats under $400?', 'We’re flying in for the game; two seats together',
      'Knicks tickets Oct 24, then dinner nearby', 'What concerts are on in Brooklyn this weekend?',
    ]) expect(outsideIntent(text, none), text).toBeNull();
    // A named team makes it a ticket request, whatever else is mentioned.
    expect(outsideIntent('Rangers tickets and a hotel near MSG', { performerOrTeam: 'Rangers' })).toBeNull();
  });

  it('spots a ticketed food or drink event', () => {
    expect(isFoodDrink('Two tickets to the Brooklyn Wine Festival on Saturday')).toBe(true);
    expect(isFoodDrink('Is the taco fest GA worth it?')).toBe(true);
    expect(isFoodDrink('Knicks tickets, then food nearby')).toBe(false);
  });
});

describe('overrides are staff-approved, scoped and expiring', () => {
  const o = parseOverrides(JSON.stringify([{ id: 'ovr-1', depth: 'core', eventIds: ['ev-1'], owner: 'tobias', reason: 'Selected NCAA rivalry game', expiresAt: '2026-10-10T00:00:00Z', evidence: 'staff review 2026-09-30' }]));
  it('raises the named event only, until it expires', () => {
    expect(resolve('ncaa_regular', { eventId: 'ev-1', overrides: o }).depth).toBe('core');
    expect(resolve('ncaa_regular', { eventId: 'ev-1', overrides: o }).overrideId).toBe('ovr-1');
    expect(resolve('ncaa_regular', { eventId: 'ev-2', overrides: o }).depth).toBe('guide');
    expect(resolveServicePolicy({ category: 'ncaa_regular', eventId: 'ev-1', overrides: o, blockedCategories: [], now: new Date('2026-10-11T00:00:00Z') }).depth).toBe('guide');
  });
  it('never lifts an operator block, an unknown category or an outside intent', () => {
    expect(resolveServicePolicy({ category: 'attractions', eventId: 'ev-1', overrides: o, blockedCategories: BLOCKED, now: NOW }).allowedOperations).toEqual(['official_lookup']);
    expect(resolve('unknown', { eventId: 'ev-1', overrides: o }).depth).toBe('guide');
    expect(resolve(null, { eventId: 'ev-1', overrides: o, outsideIntent: 'travel_reservations' }).depth).toBe('outside');
  });
  it('refuses a category-wide promotion or a malformed entry', () => {
    expect(() => parseOverrides(JSON.stringify([{ id: 'x', depth: 'core', owner: 'a', reason: 'b', expiresAt: '2026-10-10T00:00:00Z', evidence: 'c' }]))).toThrow(/name events or entities/);
    expect(() => parseOverrides('[{"id":"x"}]')).toThrow(/invalid/);
    expect(parseOverrides('')).toEqual([]);
  });
});

describe('capability: permission AND rights AND coverage', () => {
  const adapters: AdapterFacts[] = [
    { sourceId: 'mon', implementation: 'fixture', enabled: true, capabilities: ['quote_search', 'monitoring'], monitoringAllowed: true, accessApproved: true },
  ];
  const base = { adapters, licence: { tracking: true, benchmark: true, advice: true }, marketKey: true, watchSendEnabled: true, now: NOW };
  it('SD11: a monitoring adapter that does not cover the event is no watch', () => {
    const c = evaluateOperationCapability({ ...base, decision: resolve('nhl'), coveredSourceIds: [] }, 'price_watch');
    expect(c.state).toBe('unavailable');
    expect(c.reasons).toEqual(['event_not_covered']);
    expect(evaluateOperationCapability({ ...base, decision: resolve('nhl'), coveredSourceIds: ['mon'] }, 'price_watch')).toMatchObject({ state: 'available', sourceIds: ['mon'] });
  });
  it('denies by depth before looking at rights', () => {
    const guide = evaluateOperationCapability({ ...base, decision: resolve('classical'), coveredSourceIds: ['mon'] }, 'price_watch');
    expect(guide).toMatchObject({ state: 'unavailable', reasons: ['guide_official_only'] });
    expect(evaluateOperationCapability({ ...base, decision: resolve('broadway'), coveredSourceIds: ['mon'] }, 'market_tracking').reasons).toEqual(['compare_no_tracking']);
    expect(evaluateOperationCapability({ ...base, decision: resolve('nhl'), coveredSourceIds: ['mon'], watchSendEnabled: false }, 'price_watch').reasons).toEqual(['delivery_disabled']);
    expect(evaluateOperationCapability({ ...base, decision: resolve('nhl'), coveredSourceIds: ['mon'], marketKey: false }, 'market_tracking').state).toBe('unavailable');
    expect(allows(resolve('nhl'), 'market_tracking')).toBe(true);
  });
  it('maps advice claims to the operations they rely on, abstentions to none', () => {
    expect(operationsForClaims(['trend_change', 'current_offer', 'official_sale', 'coverage', 'missing_history']).sort()).toEqual(['live_comparison', 'trend_advice']);
  });
});

describe('SD04/SD24: source planning under a depth', () => {
  const adapters = [
    { sourceId: 'fx', implementation: 'fixture', enabled: true, capabilities: ['quote_search'], accessApproved: true },
    { sourceId: 'ticketmaster', implementation: 'ticketmaster_discovery', enabled: true, capabilities: ['discovery', 'event_lookup'], accessApproved: true },
    { sourceId: 'seatgeek', implementation: 'manual', enabled: true, capabilities: ['quote_search'], accessApproved: true },
    { sourceId: 'stubhub', implementation: 'manual', enabled: true, capabilities: ['quote_search'], accessApproved: false },
  ];
  it('an unknown or museum route has no generic marketplace fallback', () => {
    for (const category of ['unknown', 'attractions']) {
      const p = planSources({ category, maxAutomatedSources: 0, adapters, coveredSourceIds: [], fixtureEvent: false });
      expect(p.executable).toEqual([]);
      expect(p.unavailable.map((u) => u.sourceId)).not.toEqual(expect.arrayContaining(['ticketmaster', 'seatgeek', 'stubhub']));
    }
  });
  it('keeps only integrated, approved sources, within the budget, and says why the rest were left', () => {
    const p = planSources({ category: 'nhl', maxAutomatedSources: 1, adapters, coveredSourceIds: [], fixtureEvent: true });
    expect(p.executable).toHaveLength(1);
    const why = Object.fromEntries(p.unavailable.map((u) => [u.sourceId, u.reason]));
    expect(why.ticketmaster).toBe('source_not_integrated');
    expect(why.stubhub).toBe('source_access_unapproved');
    expect(Object.values(why)).toContain('budget_exhausted');
    expect(p.officialPointers).toEqual(['nhl-ticket-exchange']);
  });
  it('a Guide depth calls nothing, and says so per source', () => {
    const p = planSources({ category: 'classical', maxAutomatedSources: 0, adapters, coveredSourceIds: [], fixtureEvent: true });
    expect(p.executable).toEqual([]);
    expect(p.unavailable.find((u) => u.sourceId === 'fx')?.reason).toBe('depth_no_automated_sources');
  });
});

describe('SD13: the constraint basket keeps every hard requirement', () => {
  it('carries accessibility, delivery deadline and unverifiable requirements', () => {
    const b = constraintBasket({ togetherRequired: true, budgetCents: 30000, budgetBasis: 'whole_party', accessibilityNeeds: 'wheelchair accessible' }, 2, new Date('2026-10-24T23:30:00Z'), { deliveryBy: new Date('2026-10-24T21:00:00Z'), unverifiable: ['Admission for your 15-year-old (the venue’s age policy)'], revision: 1 });
    expect(b).toMatchObject({ requireAccessible: true, togetherRequired: true, budgetTotalCents: 30000, unverifiable: ['Admission for your 15-year-old (the venue’s age policy)'] });
    expect(readBasket(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(readBasket({})).toBeNull();
    expect(meetsDelivery({ expectedDeliveryAt: null }, b)).toBe(false);
    expect(meetsDelivery({ expectedDeliveryAt: '2026-10-24T20:00:00Z' }, b)).toBe(true);
    expect(meetsDelivery({ expectedDeliveryAt: '2026-10-24T22:00:00Z' }, b)).toBe(false);
  });
});

describe('SD22: affiliate payout never enters the ranking', () => {
  const offer = (id: string, cents: number, affiliate: string | null): Offer => ({ id, evidenceId: id, sourceId: 'fx', providerListingId: id, eventId: 'e', observedAt: NOW.toISOString(), providerUpdatedAt: null, expiresAt: null, currency: 'USD', quantity: 2, baseTotalCents: cents, mandatoryFeeTotalCents: 0, taxTotalCents: 0, deliveryTotalCents: 0, payableTotalCents: cents, priceCompleteness: 'verified_total', section: '101', row: '5', seatNumbers: null, seatsTogether: true, admissionType: 'reserved', restrictions: [], deliveryMethod: 'mobile_transfer', expectedDeliveryAt: null, availability: 'available', directPurchaseUrl: `https://example.invalid/${id}`, affiliateUrl: affiliate, collectionMode: 'fixture', seatClass: null } as unknown as Offer);
  it('picks the cheaper eligible offer whether or not it pays a commission', () => {
    const cmp = compareOffers([offer('paid', 30000, 'https://aff.example.invalid/x'), offer('free', 25000, null)], { quantity: 2, togetherRequired: true, budgetTotalCents: null, excludeObstructedView: true, requireAccessible: false, acceptableSections: null, eventStartAt: '2026-10-24T23:30:00Z' }, 'e');
    expect(cmp.eligible[0]!.offer.id).toBe('free');
  });
});
