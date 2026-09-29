import { describe, expect, it } from 'vitest';
import { decide, type PolicyInput } from '@/lib/advice/policy';

const now = new Date('2026-09-22T15:00:00Z');
const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  now,
  eventStartAt: new Date('2026-10-30T23:00:00Z'),
  offers: { bestEligibleTotalCents: null, bestEligibleObservationId: null, eligibleCount: 0, needsReviewCount: 0, alternativeAvailable: false, deliveryFeasible: null, safeDeliveryBufferMinutes: null },
  benchmark: null,
  trend: null,
  priorities: { mustAttend: null, waitRiskTolerance: 'high', decisionDeadline: new Date('2026-10-20T00:00:00Z'), budgetTotalCents: null, togetherRequired: true, splitGroupAllowed: null, watchConsentGiven: false },
  monitoringCoverageAvailable: false,
  staffedUntil: null,
  ...over,
});
const withOffer = { bestEligibleTotalCents: 30000, bestEligibleObservationId: 'o1', eligibleCount: 3, needsReviewCount: 0, alternativeAvailable: false, deliveryFeasible: true, safeDeliveryBufferMinutes: null };
const falling = { basisMatchesGroup: true, direction: 'down' as const, supply: 'stable' as const };

describe('buy / wait with resale market statistics', () => {
  it('a pair, prices falling, listings holding, customer can wait and has a deadline → wait and recheck', () => {
    const r = decide(base({ market: falling }));
    expect(r.decision).toBe('wait_and_recheck');
    expect(r.reasonCodes).toContain('market_prices_falling_listings_holding');
    expect(r.nextCheckpointAt).toEqual(new Date(now.getTime() + 24 * 3_600_000));
    expect(r.stopConditions).toContain('listings_shrink');
  });

  it('prices falling but listings shrinking → never wait, even for a customer happy to', () => {
    const r = decide(base({ offers: withOffer, market: { ...falling, supply: 'shrinking' } }));
    expect(r.decision).toBe('buy_now');
    expect(r.reasonCodes).toContain('market_listings_shrinking');
  });

  it('five together: a falling single-ticket market is not their market, so no wait', () => {
    const r = decide(base({ offers: withOffer, market: { basisMatchesGroup: false, direction: 'down', supply: 'stable' } }));
    expect(r.decision).toBe('buy_now');
    expect(r.decision).not.toBe('wait_and_recheck');
  });

  it('falling, but we do not know their risk tolerance or deadline → ask, do not tell them to wait', () => {
    const r = decide(base({ market: falling, priorities: { ...base().priorities, waitRiskTolerance: null, decisionDeadline: null } }));
    expect(r.decision).toBe('insufficient_evidence');
    expect(r.clarificationNeeded).toEqual(['wait_risk_tolerance', 'decision_deadline']);
  });

  it('must attend → no market wait', () => {
    expect(decide(base({ market: falling, priorities: { ...base().priorities, mustAttend: true } })).decision).not.toBe('wait_and_recheck');
  });

  it('without market data nothing changes', () => {
    expect(decide(base()).decision).toBe('insufficient_evidence');
    expect(decide(base({ offers: withOffer })).decision).toBe('buy_now');
  });
});
