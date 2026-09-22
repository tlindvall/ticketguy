/**
 * Trend engine (ADVICE_ENGINE §6). Gate: ≥4 valid observations spanning ≥6 hours, stable basket,
 * adequate common-source coverage. Direction requires endpoint movement > 3% AND > $5 per group, with
 * the median pairwise slope agreeing. No extrapolation; missing baselines yield null windows.
 */
export const TREND_METHOD_VERSION = 'trend-1.0';
export const TREND_MIN_OBSERVATIONS = 4;
export const TREND_MIN_SPAN_MINUTES = 6 * 60;
export const TREND_DIRECTION_MIN_PCT = 0.03;
export const TREND_DIRECTION_MIN_CENTS = 500;

export type TrendObservation = {
  id: string;
  observedAt: Date;
  basketKey: string;
  cheapestEligibleTotalCents: number | null;
  sourceIds: string[];
  feeBasis: 'verified_total' | 'estimated_total' | 'incomplete';
  coverageComplete: boolean;
  qualityFlags: string[];
  /** Seller/source of the cheapest eligible offer, when known; used for A59 wording, never for inference of price cuts. */
  cheapestSourceId?: string | null;
};

export type WindowChange = {
  windowHours: 6 | 24 | 72;
  baselineObservationId: string;
  baselineCents: number;
  currentCents: number;
  absoluteChangeCents: number;
  percentChange: number;
} | null;

export type TrendResult = {
  methodVersion: string;
  direction: 'up' | 'down' | 'flat' | 'mixed' | 'insufficient';
  adequacy: 'sufficient' | 'insufficient';
  reasons: string[];
  validObservationIds: string[];
  spanMinutes: number;
  sourceIntersection: string[];
  windows: { h6: WindowChange; h24: WindowChange; h72: WindowChange };
  endpointChangeCents: number | null;
  endpointChangePct: number | null;
  medianPairwiseSlopeCentsPerHour: number | null;
  /** True when the latest cheapest offer comes from a source that did not supply the previous cheapest (A59). */
  floorLoweredByNewSource: boolean;
  qualityFlags: string[];
};

const WINDOW_TOLERANCE_MINUTES = 90;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function computeTrend(observations: TrendObservation[], now: Date): TrendResult {
  const reasons: string[] = [];
  const qualityFlags = new Set<string>();
  const sorted = [...observations].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

  // A53: coverage breaks, fee-basis changes, incomplete pagination and basket changes invalidate observations.
  const basketKeys = new Set(sorted.map((o) => o.basketKey));
  if (basketKeys.size > 1) {
    reasons.push('basket_changed');
    qualityFlags.add('basket_changed');
  }
  const valid = sorted.filter((o) => {
    if (basketKeys.size > 1) return false;
    if (o.cheapestEligibleTotalCents === null) return false;
    if (o.feeBasis !== 'verified_total') {
      qualityFlags.add('fee_basis_not_verified');
      return false;
    }
    if (!o.coverageComplete) {
      qualityFlags.add('coverage_incomplete');
      return false;
    }
    if (o.qualityFlags.some((f) => f === 'source_outage' || f === 'pagination_incomplete' || f === 'seat_quality_substituted')) {
      o.qualityFlags.forEach((f) => qualityFlags.add(f));
      return false;
    }
    return true;
  });

  // Adequate common-source coverage: every valid observation must share the intersection set, and it must be non-empty.
  const intersection = valid.length ? valid.map((o) => new Set(o.sourceIds)).reduce((acc, s) => new Set([...acc].filter((x) => s.has(x)))) : new Set<string>();
  const validCommon = valid.filter((o) => o.sourceIds.length === intersection.size || intersection.size > 0);
  if (valid.length && intersection.size === 0) {
    reasons.push('no_common_source_coverage');
    qualityFlags.add('no_common_source_coverage');
  }
  const usable = intersection.size > 0 ? validCommon : [];

  const spanMinutes = usable.length >= 2 ? Math.round((usable[usable.length - 1]!.observedAt.getTime() - usable[0]!.observedAt.getTime()) / 60_000) : 0;

  const base: Omit<TrendResult, 'direction' | 'adequacy' | 'windows' | 'endpointChangeCents' | 'endpointChangePct' | 'medianPairwiseSlopeCentsPerHour' | 'floorLoweredByNewSource'> = {
    methodVersion: TREND_METHOD_VERSION,
    reasons,
    validObservationIds: usable.map((o) => o.id),
    spanMinutes,
    sourceIntersection: [...intersection].sort(),
    qualityFlags: [...qualityFlags].sort(),
  };

  if (usable.length < TREND_MIN_OBSERVATIONS) reasons.push(`fewer_than_${TREND_MIN_OBSERVATIONS}_valid_observations:${usable.length}`);
  if (spanMinutes < TREND_MIN_SPAN_MINUTES) reasons.push(`span_under_6h:${spanMinutes}m`);

  const current = usable[usable.length - 1];
  const windows = { h6: null as WindowChange, h24: null as WindowChange, h72: null as WindowChange };
  let floorLoweredByNewSource = false;
  if (current) {
    for (const h of [6, 24, 72] as const) {
      const target = current.observedAt.getTime() - h * 3_600_000;
      let best: TrendObservation | undefined;
      for (const o of usable) {
        if (o === current) continue;
        if (Math.abs(o.observedAt.getTime() - target) <= WINDOW_TOLERANCE_MINUTES * 60_000) {
          if (!best || Math.abs(o.observedAt.getTime() - target) < Math.abs(best.observedAt.getTime() - target)) best = o;
        }
      }
      if (best && best.cheapestEligibleTotalCents! > 0) {
        const b = best.cheapestEligibleTotalCents!;
        const c = current.cheapestEligibleTotalCents!;
        const key = h === 6 ? 'h6' : h === 24 ? 'h24' : 'h72';
        windows[key] = { windowHours: h, baselineObservationId: best.id, baselineCents: b, currentCents: c, absoluteChangeCents: c - b, percentChange: (c - b) / b };
      }
    }
    const prev = usable[usable.length - 2];
    if (prev && current.cheapestSourceId && prev.cheapestSourceId && current.cheapestSourceId !== prev.cheapestSourceId && current.cheapestEligibleTotalCents! < prev.cheapestEligibleTotalCents!) {
      floorLoweredByNewSource = true;
    }
  }

  if (usable.length < TREND_MIN_OBSERVATIONS || spanMinutes < TREND_MIN_SPAN_MINUTES || intersection.size === 0) {
    return { ...base, direction: 'insufficient', adequacy: 'insufficient', windows, endpointChangeCents: current && usable[0] ? current.cheapestEligibleTotalCents! - usable[0].cheapestEligibleTotalCents! : null, endpointChangePct: null, medianPairwiseSlopeCentsPerHour: null, floorLoweredByNewSource };
  }

  const first = usable[0]!;
  const endpointChangeCents = current!.cheapestEligibleTotalCents! - first.cheapestEligibleTotalCents!;
  const endpointChangePct = endpointChangeCents / first.cheapestEligibleTotalCents!;
  const slopes: number[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const dtH = (usable[j]!.observedAt.getTime() - usable[i]!.observedAt.getTime()) / 3_600_000;
      if (dtH > 0) slopes.push((usable[j]!.cheapestEligibleTotalCents! - usable[i]!.cheapestEligibleTotalCents!) / dtH);
    }
  }
  const medianSlope = median(slopes);
  const exceeds = Math.abs(endpointChangePct) > TREND_DIRECTION_MIN_PCT && Math.abs(endpointChangeCents) > TREND_DIRECTION_MIN_CENTS;
  let direction: TrendResult['direction'];
  if (!exceeds) direction = 'flat';
  else if (endpointChangeCents > 0 && medianSlope > 0) direction = 'up';
  else if (endpointChangeCents < 0 && medianSlope < 0) direction = 'down';
  else direction = 'mixed';

  void now;
  return { ...base, direction, adequacy: 'sufficient', windows, endpointChangeCents, endpointChangePct, medianPairwiseSlopeCentsPerHour: medianSlope, floorLoweredByNewSource };
}
