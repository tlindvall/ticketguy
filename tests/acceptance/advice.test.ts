import { describe, expect, it } from 'vitest';
import { computeBenchmark, quantileType7, type HistoricalSnapshot, type EventContext, type DatasetRights } from '@/lib/advice/benchmark';
import { computeTrend, type TrendObservation } from '@/lib/advice/trend';
import { decide, type PolicyInput } from '@/lib/advice/policy';
import { buildPacket } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { evaluateOffer } from '@/lib/domain/comparison';
import { fixtureOffer, FIXTURE_EVENT_ID } from '../fixtures/offers';

const ctx: EventContext = { entitySlug: 'new-york-rangers', venueId: 'msg', layoutVersion: 'v2024', category: 'nhl', subtype: 'preseason', isHome: true, dayType: 'weekday' };
const NOW = new Date('2026-09-22T15:00:00Z');
const approved: DatasetRights = { id: 'ds1', status: 'approved', approvedUses: ['benchmark', 'customer_display', 'derived_aggregates'], rawRetentionUntil: new Date('2027-01-01T00:00:00Z'), derivedRetentionUntil: new Date('2027-06-01T00:00:00Z'), isFixture: false };

function snap(over: Partial<HistoricalSnapshot> & { eventId: string; id: string }): HistoricalSnapshot {
  return {
    datasetId: 'ds1',
    quantity: 5,
    seatZone: 'upper',
    section: '212',
    cheapestEligibleTotalCents: 42500,
    feeBasis: 'verified_total',
    coverageComplete: true,
    isFixture: false,
    context: ctx,
    ...over,
    leadTimeMinutes: over.leadTimeMinutes ?? 4 * 24 * 60,
  };
}

describe('A60 benchmark quantiles', () => {
  it('type-7 quantiles match known values', () => {
    const v = [10, 20, 30, 40, 50];
    expect(quantileType7(v, 0.5)).toBe(30);
    expect(quantileType7(v, 0.25)).toBe(20);
    expect(quantileType7(v, 0.75)).toBe(40);
    expect(quantileType7([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
  it('one matched-lead-time representative per event; target excluded; P25/median/P75 match fixture math', () => {
    const snaps: HistoricalSnapshot[] = [];
    // 12 comparator events, each with 3 snapshots at different lead times inside the 3-7d bucket; representative is nearest 4d.
    for (let i = 0; i < 12; i++) {
      const price = 35000 + i * 1000; // 350..460 → per-person 70..92
      snaps.push(snap({ id: `e${i}-far`, eventId: `ev${i}`, leadTimeMinutes: 6 * 24 * 60, cheapestEligibleTotalCents: price + 9000 }));
      snaps.push(snap({ id: `e${i}-near`, eventId: `ev${i}`, leadTimeMinutes: 4 * 24 * 60 + 30, cheapestEligibleTotalCents: price }));
      snaps.push(snap({ id: `e${i}-mid`, eventId: `ev${i}`, leadTimeMinutes: 5 * 24 * 60, cheapestEligibleTotalCents: price + 5000 }));
    }
    snaps.push(snap({ id: 'target-self', eventId: 'TARGET', cheapestEligibleTotalCents: 1 }));
    const r = computeBenchmark({ targetEventId: 'TARGET', targetContext: ctx, targetQuantity: 5, targetSeatZone: 'upper', targetLeadMinutes: 4 * 24 * 60, snapshots: snaps, datasets: { ds1: approved }, now: NOW, allowFixtures: false });
    expect(r.independentEventCount).toBe(12);
    expect(r.representativeSnapshotIds.every((id) => id.endsWith('-near'))).toBe(true);
    expect(r.exclusions).toContainEqual({ eventId: 'TARGET', reason: 'target_event_excluded' });
    const vals = Array.from({ length: 12 }, (_, i) => 35000 + i * 1000);
    expect(r.medianCents).toBe(quantileType7(vals, 0.5));
    expect(r.p25Cents).toBe(quantileType7(vals, 0.25));
    expect(r.p75Cents).toBe(quantileType7(vals, 0.75));
    expect(r.adequacy).toBe('sufficient');
  });
});

describe('A50 one event = one comparator', () => {
  it('1,000 observations of one past event count once', () => {
    const snaps = Array.from({ length: 1000 }, (_, i) => snap({ id: `o${i}`, eventId: 'single-event', leadTimeMinutes: 4 * 24 * 60 + i }));
    const r = computeBenchmark({ targetEventId: 'T', targetContext: ctx, targetQuantity: 5, targetSeatZone: 'upper', targetLeadMinutes: 4 * 24 * 60, snapshots: snaps, datasets: { ds1: approved }, now: NOW, allowFixtures: false });
    expect(r.independentEventCount).toBe(1);
    expect(r.adequacy).toBe('insufficient');
    expect(r.medianCents).toBeNull();
  });
});

describe('A48 preseason vs regular season', () => {
  it('regular-season and playoff snapshots are excluded with a reason, never silently used', () => {
    const snaps = [
      ...Array.from({ length: 6 }, (_, i) => snap({ id: `rs${i}`, eventId: `rs-ev${i}`, context: { ...ctx, subtype: 'regular_season' } })),
      ...Array.from({ length: 6 }, (_, i) => snap({ id: `po${i}`, eventId: `po-ev${i}`, context: { ...ctx, subtype: 'playoffs' } })),
      ...Array.from({ length: 3 }, (_, i) => snap({ id: `ps${i}`, eventId: `ps-ev${i}` })),
    ];
    const r = computeBenchmark({ targetEventId: 'T', targetContext: ctx, targetQuantity: 5, targetSeatZone: 'upper', targetLeadMinutes: 4 * 24 * 60, snapshots: snaps, datasets: { ds1: approved }, now: NOW, allowFixtures: false });
    expect(r.independentEventCount).toBe(3);
    expect(r.exclusions.filter((e) => e.reason === 'different_subtype')).toHaveLength(12);
    expect(r.adequacy).toBe('insufficient');
  });
});

describe('A49/A51 group size', () => {
  it('single-seat snapshots never stand in for the five-seat basket; sparse data abstains', () => {
    const snaps = Array.from({ length: 10 }, (_, i) => snap({ id: `s${i}`, eventId: `ev${i}`, quantity: 1, cheapestEligibleTotalCents: 3500 }));
    const r = computeBenchmark({ targetEventId: 'T', targetContext: ctx, targetQuantity: 5, targetSeatZone: 'upper', targetLeadMinutes: 4 * 24 * 60, snapshots: snaps, datasets: { ds1: approved }, now: NOW, allowFixtures: false });
    expect(r.independentEventCount).toBe(0);
    expect(r.exclusions.every((e) => e.reason === 'different_quantity')).toBe(true);
    expect(r.adequacy).toBe('insufficient');
  });
});

describe('A62/A65/A66 licensing and fixtures', () => {
  it('fixture history is inadmissible outside fixture runs', () => {
    const snaps = Array.from({ length: 12 }, (_, i) => snap({ id: `f${i}`, eventId: `fev${i}`, isFixture: true, datasetId: null }));
    const live = computeBenchmark({ targetEventId: 'T', targetContext: ctx, targetQuantity: 5, targetSeatZone: 'upper', targetLeadMinutes: 4 * 24 * 60, snapshots: snaps, datasets: {}, now: NOW, allowFixtures: false });
    expect(live.independentEventCount).toBe(0);
    expect(live.exclusions[0]!.reason).toBe('fixture_data_not_admissible');
    const fixtureRun = computeBenchmark({ targetEventId: 'T', targetContext: ctx, targetQuantity: 5, targetSeatZone: 'upper', targetLeadMinutes: 4 * 24 * 60, snapshots: snaps, datasets: {}, now: NOW, allowFixtures: true });
    expect(fixtureRun.independentEventCount).toBe(12);
  });
  it('expired, revoked or use-restricted datasets block claims; raw retention and derived permission apply independently', () => {
    const snaps = Array.from({ length: 12 }, (_, i) => snap({ id: `l${i}`, eventId: `lev${i}` }));
    const expired = computeBenchmark({ targetEventId: 'T', targetContext: ctx, targetQuantity: 5, targetSeatZone: 'upper', targetLeadMinutes: 4 * 24 * 60, snapshots: snaps, datasets: { ds1: { ...approved, rawRetentionUntil: new Date('2026-01-01T00:00:00Z') } }, now: NOW, allowFixtures: false });
    expect(expired.independentEventCount).toBe(0);
    const revoked = computeBenchmark({ targetEventId: 'T', targetContext: ctx, targetQuantity: 5, targetSeatZone: 'upper', targetLeadMinutes: 4 * 24 * 60, snapshots: snaps, datasets: { ds1: { ...approved, status: 'revoked' } }, now: NOW, allowFixtures: false });
    expect(revoked.independentEventCount).toBe(0);
    const noDisplay = computeBenchmark({ targetEventId: 'T', targetContext: ctx, targetQuantity: 5, targetSeatZone: 'upper', targetLeadMinutes: 4 * 24 * 60, snapshots: snaps, datasets: { ds1: { ...approved, approvedUses: ['benchmark'] } }, now: NOW, allowFixtures: false });
    expect(noDisplay.independentEventCount).toBe(12);
    expect(noDisplay.customerDisplayAllowed).toBe(false);
  });
});

function obs(id: string, hoursAgo: number, cents: number, over: Partial<TrendObservation> = {}): TrendObservation {
  return { id, observedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000), basketKey: 'b1', cheapestEligibleTotalCents: cents, sourceIds: ['s1', 's2'], feeBasis: 'verified_total', coverageComplete: true, qualityFlags: [], cheapestSourceId: 's1', ...over };
}

describe('A55 / A14 trend gates', () => {
  it('four consistent observations across six hours pass; two hours cannot manufacture a 24h change', () => {
    const ok = computeTrend([obs('a', 24, 47500), obs('b', 12, 46000), obs('c', 6, 44000), obs('d', 0, 42500)], NOW);
    expect(ok.adequacy).toBe('sufficient');
    expect(ok.direction).toBe('down');
    expect(ok.windows.h24).toMatchObject({ baselineCents: 47500, currentCents: 42500 });
    const short = computeTrend([obs('a', 2, 47500), obs('b', 1.5, 46000), obs('c', 1, 44000), obs('d', 0, 42500)], NOW);
    expect(short.adequacy).toBe('insufficient');
    expect(short.windows.h24).toBeNull();
    expect(short.reasons.some((r) => r.startsWith('span_under_6h'))).toBe(true);
  });
  it('two observations or a changed basket yield insufficient/changed-basket, never a trend', () => {
    expect(computeTrend([obs('a', 24, 47500), obs('b', 0, 42500)], NOW).direction).toBe('insufficient');
    const changed = computeTrend([obs('a', 24, 47500), obs('b', 12, 46000), obs('c', 6, 44000, { basketKey: 'b2' }), obs('d', 0, 42500)], NOW);
    expect(changed.direction).toBe('insufficient');
    expect(changed.qualityFlags).toContain('basket_changed');
  });
});

describe('A53 outages and fee changes are not price movements', () => {
  it('outage / incomplete coverage / fee-basis change invalidate observations', () => {
    const r = computeTrend([obs('a', 24, 47500), obs('b', 12, 46000), obs('c', 6, 30000, { qualityFlags: ['source_outage'] }), obs('d', 3, 45000, { feeBasis: 'estimated_total' }), obs('e', 0, 44000)], NOW);
    expect(r.validObservationIds).toEqual(['a', 'b', 'e']);
    expect(r.adequacy).toBe('insufficient');
  });
  it('missing data is not a spike: null cheapest is dropped, not treated as zero/infinite', () => {
    const r = computeTrend([obs('a', 24, 47500), obs('b', 12, null as unknown as number), obs('c', 6, 46000), obs('d', 0, 45500)], NOW);
    expect(r.validObservationIds).toEqual(['a', 'c', 'd']);
  });
});

describe('A59 new seller lowers the floor', () => {
  it('flags the change as a new cheaper option, not a price cut by existing sellers', () => {
    const r = computeTrend([obs('a', 24, 47500), obs('b', 12, 47000), obs('c', 6, 46500), obs('d', 0, 42500, { cheapestSourceId: 's2' })], NOW);
    expect(r.floorLoweredByNewSource).toBe(true);
  });
});

describe('A52 divergent baskets', () => {
  it('singles falling while five-seat basket rises produces a rising group trend', () => {
    const singles = computeTrend([obs('s1', 24, 5000), obs('s2', 12, 4500), obs('s3', 6, 4000), obs('s4', 0, 3500)].map((o) => ({ ...o, basketKey: 'single' })), NOW);
    const group = computeTrend([obs('g1', 24, 40000), obs('g2', 12, 41000), obs('g3', 6, 42000), obs('g4', 0, 44000)].map((o) => ({ ...o, basketKey: 'five' })), NOW);
    expect(singles.direction).toBe('down');
    expect(group.direction).toBe('up');
  });
});

const basePolicy: PolicyInput = {
  now: NOW,
  eventStartAt: new Date('2026-10-03T23:00:00Z'),
  offers: { bestEligibleTotalCents: 42500, bestEligibleObservationId: 'o1', eligibleCount: 3, needsReviewCount: 0, alternativeAvailable: true, deliveryFeasible: true, safeDeliveryBufferMinutes: 120 },
  benchmark: { methodVersion: 'bench-1.0', representativeSnapshotIds: [], representativeEventIds: [], independentEventCount: 12, medianCents: 42500, p25Cents: 37500, p75Cents: 47500, adequacy: 'sufficient', adequacyReasons: [], exclusions: [], fallbacksApplied: [], licenseExpiresAt: null, customerDisplayAllowed: true },
  trend: computeTrend([obs('a', 24, 47500), obs('b', 12, 46000), obs('c', 6, 44000), obs('d', 0, 42500)], NOW),
  priorities: { mustAttend: true, waitRiskTolerance: 'low', decisionDeadline: new Date('2026-09-30T00:00:00Z'), budgetTotalCents: 45000, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
  monitoringCoverageAvailable: true,
  staffedUntil: null,
};

describe('A56 identical prices, different customers', () => {
  it('risk-averse must-attend → buy_now despite downward trend; risk-tolerant flexible with above-target price → wait with checkpoint', () => {
    const cautious = decide(basePolicy);
    expect(cautious.decision).toBe('buy_now');
    expect(cautious.reasonCodes).toContain('trend_down_but_certainty_prioritized');
    const flexible = decide({ ...basePolicy, offers: { ...basePolicy.offers, bestEligibleTotalCents: 48000 }, priorities: { ...basePolicy.priorities, mustAttend: false, waitRiskTolerance: 'high', budgetTotalCents: 50000 } });
    expect(flexible.decision).toBe('wait_and_recheck');
    expect(flexible.nextCheckpointAt).not.toBeNull();
    expect(flexible.waitDeadlineAt).not.toBeNull();
    expect(flexible.stopConditions.length).toBeGreaterThan(0);
  });
});

describe('A57 wait recommendations', () => {
  it('has a safe deadline, checkpoint, stop conditions, and never schedules a watch without consent', () => {
    const r = decide({ ...basePolicy, offers: { ...basePolicy.offers, bestEligibleTotalCents: 48000 }, priorities: { ...basePolicy.priorities, mustAttend: false, waitRiskTolerance: 'high', budgetTotalCents: 50000, watchConsentGiven: false } });
    expect(r.decision).toBe('wait_and_recheck');
    expect(r.watchScheduled).toBe(false);
    expect(r.reasonCodes).toContain('no_watch_consent_customer_rechecks_manually');
    // deadline is the earliest of customer deadline and event start minus delivery buffer
    expect(r.waitDeadlineAt!.getTime()).toBe(new Date('2026-09-30T00:00:00Z').getTime());
    const withConsent = decide({ ...basePolicy, offers: { ...basePolicy.offers, bestEligibleTotalCents: 48000 }, priorities: { ...basePolicy.priorities, mustAttend: false, waitRiskTolerance: 'high', budgetTotalCents: 50000, watchConsentGiven: true } });
    expect(withConsent.watchScheduled).toBe(true);
    const noCoverage = decide({ ...basePolicy, monitoringCoverageAvailable: false, offers: { ...basePolicy.offers, bestEligibleTotalCents: 48000 }, priorities: { ...basePolicy.priorities, mustAttend: false, waitRiskTolerance: 'high', budgetTotalCents: 50000, watchConsentGiven: true } });
    expect(noCoverage.watchScheduled).toBe(false);
  });
  it('unknown risk tolerance or deadline → clarification, not a confident wait', () => {
    const r = decide({ ...basePolicy, offers: { ...basePolicy.offers, bestEligibleTotalCents: 48000 }, priorities: { ...basePolicy.priorities, mustAttend: false, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: 50000 } });
    expect(r.decision).not.toBe('wait_and_recheck');
    expect(r.clarificationNeeded).toEqual(expect.arrayContaining(['wait_risk_tolerance', 'decision_deadline']));
  });
  it('never encourages waiting past safe delivery', () => {
    const r = decide({ ...basePolicy, now: new Date('2026-10-03T22:30:00Z'), priorities: { ...basePolicy.priorities, mustAttend: false, waitRiskTolerance: 'high', budgetTotalCents: 50000 }, offers: { ...basePolicy.offers, bestEligibleTotalCents: 48000 } });
    expect(r.decision).toBe('buy_now');
    expect(r.reasonCodes).toContain('past_safe_wait_window');
  });
});

describe('A58 cold start', () => {
  it('no history → current comparison with abstention, no fabricated range', () => {
    const r = decide({ ...basePolicy, benchmark: null, trend: null });
    expect(r.abstentions).toEqual(expect.arrayContaining(['no_historical_range', 'no_reliable_trend']));
    expect(r.priceAttractiveness).toBe('unknown');
  });
});

describe('A61 commission cannot change advice', () => {
  it('decision is a pure function of evidence and priorities (no affiliate input exists)', () => {
    const a = decide(basePolicy);
    const b = decide(JSON.parse(JSON.stringify({ ...basePolicy, affiliateCommissionBps: 9000 }), (k, v) => (k.endsWith('At') || k === 'now' || k === 'observedAt' || k === 'decisionDeadline') && typeof v === 'string' ? new Date(v) : v));
    expect(b.decision).toBe(a.decision);
    expect(b.reasonCodes).toEqual(a.reasonCodes);
  });
});

describe('A63 response validation', () => {
  const best = evaluateOffer(fixtureOffer({ quantity: 5, payableTotalCents: 42500, seatClass: 'upper', section: '212' }), { quantity: 5, togetherRequired: true, budgetTotalCents: 45000, excludeObstructedView: true, requireAccessible: false, acceptableSections: null, eventStartAt: '2026-10-03T23:00:00Z' }, FIXTURE_EVENT_ID);
  const policy = decide(basePolicy);
  const packet = buildPacket({ requestId: 'r1', revision: 1, quantity: 5, eventLabel: 'Fixture event', best, alternatives: [], entryReference: null, benchmark: basePolicy.benchmark, benchmarkRunId: 'b1', trend: basePolicy.trend, trendRunId: 't1', policy, priorities: basePolicy.priorities, sourcesChecked: ['fixture-source'], sourcesUnavailable: [{ sourceId: 'stubhub', status: 'not_integrated' }], independentOptionCount: 3, observedAt: NOW, evidenceExpiresAt: null, basketKey: 'b1', watchConsentReference: null, isFixture: true });

  const good = { decision: 'buy_now', opening: 'For five seats together, I would be comfortable taking this option.', paragraphs: [{ claimIds: ['C_BEST'], prose: 'Here is the best verified option for your group.' }, { claimIds: ['C_BENCH', 'C_TREND'], prose: 'For context on how this compares.' }], closing: 'Since sitting together matters more than the last few dollars, I would secure it rather than risk losing it.' };

  it('accepts a compliant response and renders facts from the packet', () => {
    const r = validateAndRender(packet, good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.textBody).toContain('$425 total ($85 each)');
      expect(r.textBody).toContain('Sources checked: fixture-source');
      expect(r.textBody).toContain('stubhub (not integrated)');
    }
  });
  it('blocks invented numbers, prohibited phrases, unknown claims, scope changes and conflicting decisions even when other claims are valid', () => {
    expect(validateAndRender(packet, { ...good, paragraphs: [{ claimIds: ['C_BEST'], prose: 'Tickets are normally $30 cheaper.' }] })).toMatchObject({ ok: false });
    expect(validateAndRender(packet, { ...good, closing: 'Prices are guaranteed to drop.' })).toMatchObject({ ok: false });
    expect(validateAndRender(packet, { ...good, paragraphs: [{ claimIds: ['C_BEST', 'C_MADE_UP'], prose: 'ok' }] })).toMatchObject({ ok: false });
    expect(validateAndRender(packet, { ...good, decision: 'wait_and_recheck' })).toMatchObject({ ok: false });
    const coldPacket = { ...packet, historicalAdequacy: 'insufficient' as const };
    expect(validateAndRender(coldPacket, good)).toMatchObject({ ok: false });
    const noDisplay = { ...packet, claimRecords: packet.claimRecords.map((c) => (c.id === 'C_BENCH' ? { ...c, customerVisible: false } : c)) };
    expect(validateAndRender(noDisplay, good)).toMatchObject({ ok: false });
  });
  it('a wait decision must carry the checkpoint claim', () => {
    const waitPolicy = decide({ ...basePolicy, offers: { ...basePolicy.offers, bestEligibleTotalCents: 48000 }, priorities: { ...basePolicy.priorities, mustAttend: false, waitRiskTolerance: 'high', budgetTotalCents: 50000 } });
    const best2 = evaluateOffer(fixtureOffer({ quantity: 5, payableTotalCents: 48000 }), { quantity: 5, togetherRequired: true, budgetTotalCents: 50000, excludeObstructedView: true, requireAccessible: false, acceptableSections: null, eventStartAt: '2026-10-03T23:00:00Z' }, FIXTURE_EVENT_ID);
    const p2 = buildPacket({ requestId: 'r1', revision: 1, quantity: 5, eventLabel: 'x', best: best2, alternatives: [], entryReference: null, benchmark: basePolicy.benchmark, benchmarkRunId: 'b', trend: basePolicy.trend, trendRunId: 't', policy: waitPolicy, priorities: basePolicy.priorities, sourcesChecked: ['fixture-source'], sourcesUnavailable: [], independentOptionCount: 3, observedAt: NOW, evidenceExpiresAt: null, basketKey: 'b1', watchConsentReference: null, isFixture: true });
    expect(validateAndRender(p2, { decision: 'wait_and_recheck', opening: 'A short wait is reasonable here.', paragraphs: [{ claimIds: ['C_BEST'], prose: 'Current option.' }], closing: 'Reply if you want us to keep looking.' })).toMatchObject({ ok: false });
    expect(validateAndRender(p2, { decision: 'wait_and_recheck', opening: 'A short wait is reasonable here.', paragraphs: [{ claimIds: ['C_BEST'], prose: 'Current option.' }, { claimIds: ['C_CHECKPOINT'], prose: 'What I would do next.' }], closing: 'Reply if you want us to keep looking.' })).toMatchObject({ ok: true });
  });
});
