import { describe, expect, it } from 'vitest';
import { compareOffers, evaluateOffer, independentOptionCount, verifiedSavings } from '@/lib/domain/comparison';
import { wholePartyBudgetCents, perPersonCents, formatUsd } from '@/lib/domain/money';
import { checkFreshness } from '@/lib/domain/freshness';
import { resolveRelativeDate } from '@/lib/domain/dates';
import type { HardConstraints } from '@/lib/domain/types';
import { fixtureOffer, FIXTURE_EVENT_ID, OTHER_EVENT_ID } from '../fixtures/offers';

const base: HardConstraints = {
  quantity: 2,
  togetherRequired: true,
  budgetTotalCents: null,
  excludeObstructedView: true,
  requireAccessible: false,
  acceptableSections: null,
  eventStartAt: '2026-10-10T23:30:00.000Z',
};

describe('A01 budget basis', () => {
  it('"two tickets, $300 total" is whole-party 30000 cents, never 60000', () => {
    expect(wholePartyBudgetCents(30000, 'whole_party', 2)).toBe(30000);
    expect(wholePartyBudgetCents(15000, 'per_ticket', 2)).toBe(30000);
    // unknown basis → null (clarify), never assumed per-ticket
    expect(wholePartyBudgetCents(30000, null, 2)).toBeNull();
  });
  it('per-person is display only and floors', () => {
    expect(perPersonCents(42501, 5)).toBe(8500);
    expect(formatUsd(42500)).toBe('$425');
    expect(formatUsd(8599)).toBe('$85.99');
  });
});

describe('A03 relative dates', () => {
  it('resolves "tomorrow" against the venue timezone and received time', () => {
    // 2026-11-01T03:30Z is 2026-10-31 23:30 in New York (EDT, UTC-4) — near midnight → ambiguous flag
    const r = resolveRelativeDate('tomorrow', new Date('2026-11-01T03:30:00Z'), 'America/New_York');
    expect(r).toMatchObject({ kind: 'resolved', localDate: '2026-11-01', ambiguous: true });
    // Same instant is 2026-10-31 20:30 in Los Angeles → tomorrow = 2026-11-01, not ambiguous
    const la = resolveRelativeDate('tomorrow', new Date('2026-11-01T03:30:00Z'), 'America/Los_Angeles');
    expect(la).toMatchObject({ kind: 'resolved', localDate: '2026-11-01', ambiguous: false });
    // DST end day (Nov 1 2026 in US) — "tomorrow" from Nov 1 noon ET is Nov 2
    expect(resolveRelativeDate('tomorrow', new Date('2026-11-01T17:00:00Z'), 'America/New_York')).toMatchObject({ localDate: '2026-11-02' });
  });
  it('is unresolved without a venue timezone', () => {
    expect(resolveRelativeDate('tomorrow', new Date(), null)).toEqual({ kind: 'unresolved', reason: 'venue_timezone_unknown' });
  });
});

describe('A06 adjacency', () => {
  it('unknown contiguity for a required pair is flagged for review, never asserted', () => {
    const e = evaluateOffer(fixtureOffer({ seatsTogether: null }), base, FIXTURE_EVENT_ID);
    expect(e.verdict).toBe('needs_review');
    expect(e.flags).toContain('adjacency_unknown');
  });
  it('known non-adjacent is excluded', () => {
    expect(evaluateOffer(fixtureOffer({ seatsTogether: false }), base, FIXTURE_EVENT_ID).exclusions).toContain('seats_not_together');
  });
});

describe('A07 wrong-kind listings excluded from equivalent comparison', () => {
  it('parking, other session and obstructed view are excluded even when cheaper', () => {
    const cheapParking = fixtureOffer({ payableTotalCents: 3000, restrictions: ['parking_only'] });
    const otherSession = fixtureOffer({ payableTotalCents: 5000, restrictions: ['different_session'] });
    const obstructed = fixtureOffer({ payableTotalCents: 6000, restrictions: ['obstructed_view'] });
    const wrongEvent = fixtureOffer({ payableTotalCents: 1000, eventId: OTHER_EVENT_ID });
    const good = fixtureOffer({ payableTotalCents: 24000 });
    const r = compareOffers([cheapParking, otherSession, obstructed, wrongEvent, good], base, FIXTURE_EVENT_ID);
    expect(r.eligible.map((e) => e.offer.id)).toEqual([good.id]);
    expect(r.excluded).toHaveLength(4);
  });
});

describe('A08 unknown fees/taxes', () => {
  it('null charges are never treated as zero and never produce verified savings', () => {
    const incomplete = fixtureOffer({ payableTotalCents: null, mandatoryFeeTotalCents: null, taxTotalCents: null, baseTotalCents: 10000, priceCompleteness: 'incomplete' });
    const e = evaluateOffer(incomplete, base, FIXTURE_EVENT_ID);
    expect(e.verdict).toBe('needs_review');
    expect(e.comparableTotalCents).toBeNull();
    expect(e.flags).toEqual(expect.arrayContaining(['fees_unknown', 'tax_unknown']));
    const baseline = fixtureOffer({ payableTotalCents: 30000 });
    expect(verifiedSavings(baseline, e)).toBeNull();
    const estimated = evaluateOffer(fixtureOffer({ priceCompleteness: 'estimated_total' }), base, FIXTURE_EVENT_ID);
    expect(verifiedSavings(baseline, estimated)).toBeNull();
    const verified = evaluateOffer(fixtureOffer({ payableTotalCents: 24000 }), base, FIXTURE_EVENT_ID);
    expect(verifiedSavings(baseline, verified)).toBe(6000);
  });
  it('an over-budget offer is excluded, not silently recommended', () => {
    const e = evaluateOffer(fixtureOffer({ payableTotalCents: 50000 }), { ...base, budgetTotalCents: 30000 }, FIXTURE_EVENT_ID);
    expect(e.exclusions).toContain('over_budget');
  });
});

describe('A09/A61 affiliate commission cannot affect ranking', () => {
  it('ranking is identical when commissions change', () => {
    const a = fixtureOffer({ id: 'a', payableTotalCents: 25000, affiliateCommissionBps: 0 });
    const b = fixtureOffer({ id: 'b', payableTotalCents: 24000, affiliateCommissionBps: 0 });
    const r1 = compareOffers([a, b], base, FIXTURE_EVENT_ID).eligible.map((e) => e.offer.id);
    const a2 = { ...a, affiliateCommissionBps: 5000, affiliateUrl: 'https://example.invalid/aff/a' };
    const b2 = { ...b, affiliateCommissionBps: 0 };
    const r2 = compareOffers([a2, b2], base, FIXTURE_EVENT_ID).eligible.map((e) => e.offer.id);
    expect(r1).toEqual(['b', 'a']);
    expect(r2).toEqual(r1);
  });
});

describe('A10 shared broker listings', () => {
  it('same section/row/qty on two sources is a duplicate hint and suppresses unique counts', () => {
    const x = fixtureOffer({ id: 'x', sourceId: 's1', section: '212', row: 'C' });
    const y = fixtureOffer({ id: 'y', sourceId: 's2', section: '212', row: 'C', payableTotalCents: 24500 });
    const r = compareOffers([x, y], base, FIXTURE_EVENT_ID);
    expect(r.possibleDuplicates).toEqual([['x', 'y']]);
    expect(independentOptionCount(r)).toBeNull();
  });
});

describe('better seats are a separate group, not the cheapest equivalent', () => {
  it('groups by seat class', () => {
    const upper = fixtureOffer({ id: 'u', seatClass: 'upper', payableTotalCents: 24000 });
    const lower = fixtureOffer({ id: 'l', seatClass: 'lower', payableTotalCents: 60000 });
    const r = compareOffers([upper, lower], base, FIXTURE_EVENT_ID);
    expect(Object.keys(r.groups).sort()).toEqual(['lower', 'upper']);
  });
});

describe('A27 freshness', () => {
  const start = new Date('2026-10-10T23:30:00Z');
  it('uses a 5-minute window under 24 hours and 15 minutes otherwise', () => {
    const near = new Date('2026-10-10T20:00:00Z');
    expect(checkFreshness({ fetchedAt: new Date(near.getTime() - 6 * 60_000), sourceAsOf: null, eventStartAt: start, now: near }).fresh).toBe(false);
    const far = new Date('2026-10-01T20:00:00Z');
    expect(checkFreshness({ fetchedAt: new Date(far.getTime() - 10 * 60_000), sourceAsOf: null, eventStartAt: start, now: far }).fresh).toBe(true);
  });
  it('a fresh fetch of a stale cached feed is not a fresh observation', () => {
    const now = new Date('2026-10-01T20:00:00Z');
    const v = checkFreshness({ fetchedAt: now, sourceAsOf: new Date(now.getTime() - 60 * 60_000), eventStartAt: start, now });
    expect(v).toMatchObject({ fresh: false, reason: 'source_data_stale' });
  });
});
