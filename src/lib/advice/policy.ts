import type { Adequacy, BenchmarkResult } from './benchmark';
import type { TrendResult } from './trend';

/**
 * Buy/wait decision policy (ADVICE_ENGINE §7). Rule-based, versioned, human reviewed.
 * Price attractiveness and timing advice are separate outputs. Affiliate data is not an input.
 */
export const POLICY_VERSION = 'policy-1.0';

export type Decision = 'buy_now' | 'wait_and_recheck' | 'consider_alternative' | 'insufficient_evidence';
export type PriceAttractiveness = 'below_typical' | 'within_typical' | 'above_typical' | 'unknown';

export type CustomerPriorities = {
  mustAttend: boolean | null;
  waitRiskTolerance: 'low' | 'medium' | 'high' | null;
  decisionDeadline: Date | null;
  budgetTotalCents: number | null;
  togetherRequired: boolean | null;
  splitGroupAllowed: boolean | null;
  watchConsentGiven: boolean;
};

export type CurrentOfferSummary = {
  bestEligibleTotalCents: number | null; // verified, eligible, whole-party
  bestEligibleObservationId: string | null;
  eligibleCount: number;
  needsReviewCount: number;
  /** Alternatives in other seat classes or the customer allowed alternatives. */
  alternativeAvailable: boolean;
  deliveryFeasible: boolean | null; // null = unknown
  /** Verified provider delivery buffer in minutes (from source terms); null when unknown → conservative default. */
  safeDeliveryBufferMinutes: number | null;
};

export type PolicyInput = {
  now: Date;
  eventStartAt: Date;
  offers: CurrentOfferSummary;
  benchmark: BenchmarkResult | null;
  trend: TrendResult | null;
  priorities: CustomerPriorities;
  /** Whether unattended monitoring coverage exists for this event's sources (manual-only sources cannot support watches). */
  monitoringCoverageAvailable: boolean;
  staffedUntil: Date | null;
};

export type PolicyResult = {
  policyVersion: string;
  decision: Decision;
  priceAttractiveness: PriceAttractiveness;
  reasonCodes: string[];
  abstentions: string[];
  nextCheckpointAt: Date | null;
  waitDeadlineAt: Date | null;
  stopConditions: string[];
  clarificationNeeded: string[];
  watchScheduled: boolean; // never true without consent
};

const DEFAULT_SAFE_DELIVERY_BUFFER_MINUTES = 24 * 60; // conservative when provider terms are unverified

export function priceAttractiveness(bestTotalCents: number | null, benchmark: BenchmarkResult | null): PriceAttractiveness {
  if (bestTotalCents === null || !benchmark || benchmark.adequacy === 'insufficient' || benchmark.p25Cents === null || benchmark.p75Cents === null) return 'unknown';
  if (bestTotalCents < benchmark.p25Cents) return 'below_typical';
  if (bestTotalCents > benchmark.p75Cents) return 'above_typical';
  return 'within_typical';
}

export function decide(input: PolicyInput): PolicyResult {
  const reasons: string[] = [];
  const abstentions: string[] = [];
  const stop: string[] = [];
  const clarify: string[] = [];
  const { offers, priorities, benchmark, trend } = input;

  const attractiveness = priceAttractiveness(offers.bestEligibleTotalCents, benchmark);
  if (!benchmark || benchmark.adequacy === 'insufficient') abstentions.push('no_historical_range');
  else if (benchmark.adequacy === 'limited') reasons.push('historical_sample_small');
  if (!trend || trend.adequacy === 'insufficient') abstentions.push('no_reliable_trend');

  const bufferMin = offers.safeDeliveryBufferMinutes ?? DEFAULT_SAFE_DELIVERY_BUFFER_MINUTES;
  const deliveryCutoff = new Date(input.eventStartAt.getTime() - bufferMin * 60_000);
  const candidates: Date[] = [deliveryCutoff];
  if (priorities.decisionDeadline) candidates.push(priorities.decisionDeadline);
  if (input.staffedUntil) candidates.push(input.staffedUntil);
  const waitDeadline = new Date(Math.min(...candidates.map((d) => d.getTime())));
  const waitWindowMinutes = (waitDeadline.getTime() - input.now.getTime()) / 60_000;

  const hasOffer = offers.bestEligibleTotalCents !== null;
  const withinBudget = hasOffer && (priorities.budgetTotalCents === null || offers.bestEligibleTotalCents! <= priorities.budgetTotalCents);

  const finish = (decision: Decision, extra: Partial<PolicyResult> = {}): PolicyResult => ({
    policyVersion: POLICY_VERSION,
    decision,
    priceAttractiveness: attractiveness,
    reasonCodes: reasons,
    abstentions,
    nextCheckpointAt: null,
    waitDeadlineAt: null,
    stopConditions: stop,
    clarificationNeeded: clarify,
    watchScheduled: false,
    ...extra,
  });

  // No qualifying offer inside budget → report no fit; alternatives or watch, never silently exceed budget.
  if (!hasOffer || !withinBudget) {
    reasons.push(hasOffer ? 'no_offer_within_budget' : 'no_verified_eligible_offer');
    if (offers.needsReviewCount > 0) reasons.push('offers_pending_review');
    if (offers.alternativeAvailable) return finish('consider_alternative');
    return finish('insufficient_evidence');
  }

  // Deadline/delivery/must-attend pressure favors securing a suitable option; never encourage waiting past safe delivery.
  const urgent = waitWindowMinutes <= 0 || offers.deliveryFeasible === false;
  if (urgent) {
    reasons.push(waitWindowMinutes <= 0 ? 'past_safe_wait_window' : 'delivery_uncertain');
    return finish('buy_now');
  }
  if (priorities.mustAttend === true && (priorities.waitRiskTolerance === 'low' || priorities.waitRiskTolerance === null)) {
    reasons.push('must_attend_low_risk_tolerance');
    if (trend?.direction === 'down') reasons.push('trend_down_but_certainty_prioritized');
    return finish('buy_now');
  }

  // Group basket trending down, price above target, adequate options, and customer explicitly accepts waiting risk.
  const groupTrendDown = trend?.adequacy === 'sufficient' && trend.direction === 'down';
  const aboveTarget = attractiveness === 'above_typical' || (priorities.budgetTotalCents !== null && offers.bestEligibleTotalCents! > priorities.budgetTotalCents * 0.9);
  if (groupTrendDown && aboveTarget) {
    if (priorities.waitRiskTolerance === null || priorities.decisionDeadline === null) {
      if (priorities.waitRiskTolerance === null) clarify.push('wait_risk_tolerance');
      if (priorities.decisionDeadline === null) clarify.push('decision_deadline');
      reasons.push('wait_possible_but_risk_tolerance_or_deadline_unknown');
      return finish('buy_now', { clarificationNeeded: clarify });
    }
    if (priorities.waitRiskTolerance === 'high' || priorities.waitRiskTolerance === 'medium') {
      reasons.push('group_basket_trending_down', 'customer_accepts_wait_risk');
      stop.push('eligible_group_options_narrow', 'price_reverses_up', 'delivery_cutoff_approaches', 'customer_deadline', 'event_status_change');
      const checkpoint = new Date(Math.min(waitDeadline.getTime(), input.now.getTime() + 24 * 3_600_000));
      const watchScheduled = priorities.watchConsentGiven && input.monitoringCoverageAvailable;
      if (!priorities.watchConsentGiven) reasons.push('no_watch_consent_customer_rechecks_manually');
      else if (!input.monitoringCoverageAvailable) reasons.push('monitoring_coverage_unavailable_customer_rechecks_manually');
      return finish('wait_and_recheck', { nextCheckpointAt: checkpoint, waitDeadlineAt: waitDeadline, watchScheduled });
    }
  }
  if (trend?.adequacy === 'sufficient' && trend.direction === 'up') reasons.push('group_basket_trending_up');
  if (attractiveness === 'below_typical' || attractiveness === 'within_typical') reasons.push(`price_${attractiveness}`);
  reasons.push('suitable_verified_offer_within_budget');
  return finish('buy_now');
}

export function adequacyLabel(a: Adequacy | 'insufficient' | 'sufficient'): string {
  return a === 'sufficient' ? 'sufficient' : a === 'limited' ? 'limited' : 'insufficient';
}
