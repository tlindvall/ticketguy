import { describe, expect, it } from 'vitest';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import type { MarketContext } from '@/lib/market/series';

const at = new Date('2026-10-20T12:00:00Z');
const ctx = (over: Partial<MarketContext> = {}): MarketContext => ({ methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 13000, at, activeListings: 400 }, h24: null, h72: { hours: 72, fromCents: 16000, toCents: 13000, changeCents: -3000, pct: -0.19 }, direction: 'down', supply: { trend: 'stable', now: 400, before: 390, hours: 72 }, typical: null, points: 12, ...over });
const args = (over: Partial<BuildPacketArgs>, market: MarketContext = ctx()) => ({
  requestId: 'r', revision: 1, quantity: 2, eventLabel: 'x', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
  policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
  priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false },
  sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
  market: { basis: 'pair', context: market, supply: market.supply, supplyScope: 'all', comparableLabel: null, visible: true }, ...over,
}) as unknown as BuildPacketArgs;
const read = (a: BuildPacketArgs) => buildPacket(a).claimRecords.find((c) => c.id === 'C_READ')?.text ?? '';

describe('timing advice follows the buyer, not just the market', () => {
  it('falling prices alone are "not enough to say", with the deadline and risk asked for', () => {
    const p = buildPacket(args({}));
    expect(p.claimRecords.find((c) => c.id === 'C_READ')!.text).toContain('Whether waiting is worth it depends on when you need to decide and how much you’d mind missing out');
    expect(p.followUps).toEqual(expect.arrayContaining(['When do you need to have tickets sorted by?', 'Would you rather lock in seats now, or wait for a better price and accept you might miss out?']));
  });
  it('a buyer who can wait, and has a deadline, is told there is no need to rush before it', () => {
    expect(read(args({ priorities: { mustAttend: false, waitRiskTolerance: 'high', decisionDeadline: new Date('2026-10-28T00:00:00Z'), budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false } }))).toContain('no need to rush before your deadline');
  });
  it('someone travelling to it, or who must go, is not told to hold out', () => {
    expect(read(args({ travelling: true }))).toContain('since you can’t risk missing it, I wouldn’t hold out for a lower price');
  });
  it('stale or venue-wide figures give no trend call for the seats they asked about', () => {
    expect(read(args({}, ctx({ reasons: ['stale_48h'] })))).not.toContain('easing');
    const lower = buildPacket(args({ seatingPreference: 'lower level' }));
    expect(lower.claimRecords.find((c) => c.id === 'C_MARKET')!.text).toContain('That’s across the whole venue, not only lower level seats.');
    expect(lower.claimRecords.find((c) => c.id === 'C_READ')!.text).not.toContain('easing');
  });
});
