import { createHash } from 'node:crypto';
import { formatUsd, perPersonCents } from '@/lib/domain/money';
import type { BenchmarkResult } from './benchmark';
import type { TrendResult } from './trend';
import type { PolicyResult, CustomerPriorities } from './policy';
import type { Evaluated } from '@/lib/domain/comparison';

/**
 * Typed evidence packet (API_AND_DATA_CONTRACTS §10). Every fact the customer sees is a server-rendered
 * claim with an ID, scope and allowed wording. The model may only reference claim IDs.
 */
export type ClaimKind = 'current_offer' | 'alternative_offer' | 'benchmark_range' | 'trend_change' | 'option_count' | 'coverage' | 'entry_reference' | 'checkpoint' | 'missing_history' | 'observation_time';

export type ClaimRecord = {
  id: string;
  kind: ClaimKind;
  text: string; // server-rendered sentence
  values: Record<string, string | number | null>;
  scope: { quantity: number | null; seatZone: string | null; feeBasis: string | null; observedAt: string | null };
  evidenceIds: string[];
  methodVersion: string | null;
  limitations: string[];
  /** Whether the claim may appear in customer-facing output (licensing / adequacy). */
  customerVisible: boolean;
  url?: string | null;
};

export type AdvicePacket = {
  requestId: string;
  revision: number;
  verifiedOfferObservationIds: string[];
  basketKey: string;
  basketVersion: number;
  benchmarkRunId: string | null;
  trendRunId: string | null;
  historicalAdequacy: 'sufficient' | 'limited' | 'insufficient';
  trendAdequacy: 'sufficient' | 'insufficient';
  customerPriorities: Record<string, unknown>;
  policyVersion: string;
  decision: PolicyResult['decision'];
  reasonCodes: string[];
  abstentions: string[];
  claimRecords: ClaimRecord[];
  evidenceExpiresAt: string | null;
  nextCheckpointAt: string | null;
  stopConditions: string[];
  watchConsentReference: string | null;
  isFixture: boolean;
};

/** Display-only rounding for benchmark per-person figures; whole-party cents remain the source of truth. */
function roundToDollar(cents: number): number {
  return Math.round(cents / 100) * 100;
}

export function packetHash(p: AdvicePacket): string {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex');
}

export type BuildPacketArgs = {
  requestId: string;
  revision: number;
  quantity: number;
  eventLabel: string; // "New York Rangers vs ... — Madison Square Garden, Oct 3 7:00 PM ET"
  best: Evaluated | null;
  alternatives: Evaluated[]; // up to 2, different seat class or clearly labeled
  entryReference: Evaluated | null; // single-seat reference if verified
  benchmark: BenchmarkResult | null;
  benchmarkRunId: string | null;
  trend: TrendResult | null;
  trendRunId: string | null;
  policy: PolicyResult;
  priorities: CustomerPriorities;
  sourcesChecked: string[];
  sourcesUnavailable: Array<{ sourceId: string; status: string }>;
  independentOptionCount: number | null;
  observedAt: Date;
  evidenceExpiresAt: Date | null;
  basketKey: string;
  watchConsentReference: string | null;
  isFixture: boolean;
};

export function buildPacket(a: BuildPacketArgs): AdvicePacket {
  const claims: ClaimRecord[] = [];
  const obs = a.observedAt.toISOString();
  const q = a.quantity;

  if (a.best && a.best.comparableTotalCents !== null) {
    const total = a.best.comparableTotalCents;
    const pp = perPersonCents(total, q);
    claims.push({
      id: 'C_BEST',
      kind: 'current_offer',
      text: `${q} seat${q > 1 ? 's' : ''} together${a.best.offer.section ? ` in section ${a.best.offer.section}` : ''}: ${formatUsd(total)} total (${formatUsd(pp)} each) including the verified charges, checked ${obs}.`,
      values: { totalCents: total, perPersonCents: pp, section: a.best.offer.section, sourceId: a.best.offer.sourceId },
      scope: { quantity: q, seatZone: a.best.offer.seatClass ?? null, feeBasis: a.best.offer.priceCompleteness, observedAt: obs },
      evidenceIds: [a.best.offer.evidenceId],
      methodVersion: null,
      limitations: a.best.flags,
      customerVisible: true,
      url: a.best.offer.directPurchaseUrl,
    });
  }
  a.alternatives.slice(0, 2).forEach((alt, i) => {
    if (alt.comparableTotalCents === null) return;
    claims.push({
      id: `C_ALT${i + 1}`,
      kind: 'alternative_offer',
      text: `Alternative (${alt.offer.seatClass ?? alt.offer.admissionType}${alt.offer.section ? `, section ${alt.offer.section}` : ''}): ${formatUsd(alt.comparableTotalCents)} total for ${q}${alt.offer.priceCompleteness === 'verified_total' ? '' : ' (estimated; some charges unknown)'}.`,
      values: { totalCents: alt.comparableTotalCents, sourceId: alt.offer.sourceId },
      scope: { quantity: q, seatZone: alt.offer.seatClass ?? null, feeBasis: alt.offer.priceCompleteness, observedAt: obs },
      evidenceIds: [alt.offer.evidenceId],
      methodVersion: null,
      limitations: alt.flags,
      customerVisible: true,
      url: alt.offer.directPurchaseUrl,
    });
  });
  if (a.entryReference && a.entryReference.comparableTotalCents !== null) {
    claims.push({
      id: 'C_ENTRY',
      kind: 'entry_reference',
      text: `The cheapest single seat we verified is ${formatUsd(a.entryReference.comparableTotalCents)}${a.entryReference.offer.seatClass && a.best?.offer.seatClass && a.entryReference.offer.seatClass !== a.best.offer.seatClass ? ' in a different part of the venue' : ''} — an entry-price reference, not a price for ${q} together.`,
      values: { totalCents: a.entryReference.comparableTotalCents },
      scope: { quantity: 1, seatZone: a.entryReference.offer.seatClass ?? null, feeBasis: a.entryReference.offer.priceCompleteness, observedAt: obs },
      evidenceIds: [a.entryReference.offer.evidenceId],
      methodVersion: null,
      limitations: ['not_a_group_price'],
      customerVisible: true,
    });
  }
  if (a.benchmark && a.benchmark.adequacy !== 'insufficient' && a.benchmark.p25Cents !== null && a.benchmark.p75Cents !== null && a.benchmark.medianCents !== null) {
    const n = a.benchmark.independentEventCount;
    const small = a.benchmark.adequacy === 'limited';
    claims.push({
      id: 'C_BENCH',
      kind: 'benchmark_range',
      text: `${small ? `Across a small sample of ${n}` : `Across ${n}`} comparable past events, the best ${q}-seat options we observed at a similar point before the event were ${small ? '' : 'typically '}${formatUsd(roundToDollar(perPersonCents(Math.round(a.benchmark.p25Cents), q)))}–${formatUsd(roundToDollar(perPersonCents(Math.round(a.benchmark.p75Cents), q)))} per person (median ${formatUsd(roundToDollar(perPersonCents(Math.round(a.benchmark.medianCents), q)))}). These are observed asking prices, not sale prices.`,
      values: { events: n, p25Cents: a.benchmark.p25Cents, p75Cents: a.benchmark.p75Cents, medianCents: a.benchmark.medianCents },
      scope: { quantity: q, seatZone: null, feeBasis: 'verified_total', observedAt: null },
      evidenceIds: a.benchmark.representativeSnapshotIds,
      methodVersion: a.benchmark.methodVersion,
      limitations: [...a.benchmark.adequacyReasons, 'asking_prices_not_sales'],
      customerVisible: a.benchmark.customerDisplayAllowed,
    });
  } else {
    claims.push({
      id: 'C_NOHIST',
      kind: 'missing_history',
      text: `We don't yet have enough comparable history for this event to say what's typical, so this is a current-market comparison only.`,
      values: { events: a.benchmark?.independentEventCount ?? 0 },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: null },
      evidenceIds: [],
      methodVersion: a.benchmark?.methodVersion ?? null,
      limitations: a.benchmark?.adequacyReasons ?? ['no_benchmark_run'],
      customerVisible: true,
    });
  }
  if (a.trend) {
    const w = a.trend.windows.h24 ?? a.trend.windows.h6 ?? a.trend.windows.h72;
    if (a.trend.adequacy === 'sufficient' && w) {
      const dirWord = a.trend.direction === 'down' ? 'fallen' : a.trend.direction === 'up' ? 'risen' : 'moved';
      const newSource = a.trend.floorLoweredByNewSource ? ' The lower price comes from a different seller, so this reflects a new cheaper option rather than existing sellers cutting prices.' : '';
      claims.push({
        id: 'C_TREND',
        kind: 'trend_change',
        text: `Your group's cheapest comparable option has ${dirWord} from ${formatUsd(w.baselineCents)} to ${formatUsd(w.currentCents)} over the last ${w.windowHours} hours (${a.trend.direction === 'flat' || a.trend.direction === 'mixed' ? 'no clear direction' : a.trend.direction}).${newSource} Past movement does not predict the next one.`,
        values: { baselineCents: w.baselineCents, currentCents: w.currentCents, windowHours: w.windowHours, direction: a.trend.direction },
        scope: { quantity: q, seatZone: null, feeBasis: 'verified_total', observedAt: obs },
        evidenceIds: a.trend.validObservationIds,
        methodVersion: a.trend.methodVersion,
        limitations: a.trend.qualityFlags,
        customerVisible: true,
      });
    } else {
      claims.push({
        id: 'C_NOTREND',
        kind: 'trend_change',
        text: `We have only ${a.trend.validObservationIds.length} comparable price observations over ${Math.round(a.trend.spanMinutes / 60)} hours for your group size, which isn't enough to call a trend.`,
        values: { observations: a.trend.validObservationIds.length, spanMinutes: a.trend.spanMinutes },
        scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
        evidenceIds: a.trend.validObservationIds,
        methodVersion: a.trend.methodVersion,
        limitations: a.trend.reasons,
        customerVisible: true,
      });
    }
  }
  if (a.independentOptionCount !== null) {
    claims.push({
      id: 'C_COUNT',
      kind: 'option_count',
      text: `${a.independentOptionCount} qualifying listing${a.independentOptionCount === 1 ? '' : 's'} for ${q} together among the sources we checked.`,
      values: { count: a.independentOptionCount },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['sources_checked_only'],
      customerVisible: true,
    });
  }
  const unavailable = a.sourcesUnavailable.map((s) => `${s.sourceId} (${s.status.replace(/_/g, ' ')})`);
  claims.push({
    id: 'C_COVERAGE',
    kind: 'coverage',
    text: `Sources checked: ${a.sourcesChecked.length ? a.sourcesChecked.join(', ') : 'none'}.${unavailable.length ? ` Not checked or unavailable: ${unavailable.join(', ')}.` : ''} Prices can change before checkout.`,
    values: { checked: a.sourcesChecked.length, unavailable: unavailable.length },
    scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
    evidenceIds: [],
    methodVersion: null,
    limitations: [],
    customerVisible: true,
  });
  if (a.policy.nextCheckpointAt) {
    claims.push({
      id: 'C_CHECKPOINT',
      kind: 'checkpoint',
      text: `Recheck point: ${a.policy.nextCheckpointAt.toISOString()}${a.policy.waitDeadlineAt ? `; decide by ${a.policy.waitDeadlineAt.toISOString()} at the latest` : ''}. ${a.policy.watchScheduled ? 'We will check for you and email if a qualifying offer appears.' : 'We are not monitoring this automatically; reply if you want us to.'}`,
      values: { nextCheckpointAt: a.policy.nextCheckpointAt.toISOString(), waitDeadlineAt: a.policy.waitDeadlineAt?.toISOString() ?? null, watchScheduled: a.policy.watchScheduled ? 1 : 0 },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: a.policy.policyVersion,
      limitations: a.policy.stopConditions,
      customerVisible: true,
    });
  }

  return {
    requestId: a.requestId,
    revision: a.revision,
    verifiedOfferObservationIds: [a.best, ...a.alternatives, a.entryReference].filter((e): e is Evaluated => !!e).map((e) => e.offer.id),
    basketKey: a.basketKey,
    basketVersion: 1,
    benchmarkRunId: a.benchmarkRunId,
    trendRunId: a.trendRunId,
    historicalAdequacy: a.benchmark?.adequacy ?? 'insufficient',
    trendAdequacy: a.trend?.adequacy ?? 'insufficient',
    customerPriorities: { ...a.priorities, decisionDeadline: a.priorities.decisionDeadline?.toISOString() ?? null },
    policyVersion: a.policy.policyVersion,
    decision: a.policy.decision,
    reasonCodes: a.policy.reasonCodes,
    abstentions: a.policy.abstentions,
    claimRecords: claims,
    evidenceExpiresAt: a.evidenceExpiresAt?.toISOString() ?? null,
    nextCheckpointAt: a.policy.nextCheckpointAt?.toISOString() ?? null,
    stopConditions: a.policy.stopConditions,
    watchConsentReference: a.watchConsentReference,
    isFixture: a.isFixture,
  };
}
