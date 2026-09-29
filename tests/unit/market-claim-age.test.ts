import { describe, expect, it } from 'vitest';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import { computeMarketContext } from '@/lib/market/series';

const H = 3_600_000;
const start = new Date('2026-10-01T23:00:00Z');
const base = (observedAt: Date, market: BuildPacketArgs['market']) => ({
  requestId: 'r', revision: 1, quantity: 1, eventLabel: 'x', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
  policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p' },
  priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null },
  sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
  official: null, faceValue: null, quote: null, market,
}) as unknown as BuildPacketArgs;

describe('a market figure says how old it is', () => {
  // Every 6 hours for three days, the floor easing from $97 to $79; the newest point is at `last`.
  const last = new Date('2026-09-29T02:00:00Z');
  const points = Array.from({ length: 13 }, (_, i) => ({ observedAt: new Date(last.getTime() - (12 - i) * 6 * H), priceCents: 9700 - i * 150, activeListings: 3800 - i * 40 }));
  const claimAt = (now: Date) => {
    const context = computeMarketContext({ basis: 'single', zone: null, points, now, eventStartAt: start });
    const p = buildPacket(base(now, { basis: 'single', context, supply: context.supply, supplyScope: 'all', comparableLabel: null, visible: true }));
    return p.claimRecords.find((c) => c.id === 'C_MARKET')?.text ?? null;
  };

  it('"currently" when recent; its age when it is hours old; nothing when a day old', () => {
    expect(claimAt(new Date(last.getTime() + H))).toMatch(/^Resale listings for a single ticket currently start at \$79/);
    // The Rangers card: the newest SeatData figure was 13 hours old. It is still said, with its age.
    expect(claimAt(new Date(last.getTime() + 13 * H))).toMatch(/^As of about 13 hours ago, resale listings for a single ticket started at \$79/);
    expect(claimAt(new Date(last.getTime() + 30 * H))).toBeNull();
  });
});
