/**
 * Historical benchmark (ADVICE_ENGINE §4). One representative snapshot per comparator event at a matched
 * lead time; target event excluded; quantiles over event representatives with equal weighting (type 7).
 * Never fabricates history: when the cohort is thin, adequacy is 'limited'/'insufficient'.
 */
export const BENCHMARK_METHOD_VERSION = 'bench-1.0';

export type LeadBucket = '0-6h' | '6-24h' | '1-3d' | '3-7d' | '7-14d' | '14-30d' | '30d+';

export function leadBucket(leadMinutes: number): LeadBucket {
  const h = leadMinutes / 60;
  if (h < 6) return '0-6h';
  if (h < 24) return '6-24h';
  if (h < 72) return '1-3d';
  if (h < 168) return '3-7d';
  if (h < 336) return '7-14d';
  if (h < 720) return '14-30d';
  return '30d+';
}

export type HistoricalSnapshot = {
  id: string;
  eventId: string;
  datasetId: string | null;
  quantity: number;
  seatZone: string | null;
  section: string | null;
  leadTimeMinutes: number;
  cheapestEligibleTotalCents: number | null;
  feeBasis: 'verified_total' | 'estimated_total' | 'incomplete';
  coverageComplete: boolean;
  isFixture: boolean;
  /** Context of the comparator event, matched against the target. */
  context: EventContext;
};

export type EventContext = {
  entitySlug: string; // home team / performer
  venueId: string;
  layoutVersion: string | null;
  category: string;
  subtype: string | null; // preseason | regular_season | playoffs | ...
  isHome: boolean | null;
  dayType: 'weekday' | 'weekend' | null;
};

export type DatasetRights = {
  id: string;
  status: 'quarantined' | 'approved' | 'revoked' | 'expired';
  approvedUses: string[]; // 'benchmark' | 'customer_display' | 'derived_aggregates'
  rawRetentionUntil: Date | null;
  derivedRetentionUntil: Date | null;
  isFixture: boolean;
};

export type BenchmarkInput = {
  targetEventId: string;
  targetContext: EventContext;
  targetQuantity: number;
  targetSeatZone: string | null;
  targetLeadMinutes: number;
  snapshots: HistoricalSnapshot[];
  datasets: Record<string, DatasetRights>;
  now: Date;
  /** Fixture snapshots are only admissible when the run itself is a fixture run (A65). */
  allowFixtures: boolean;
  /** Approved, visible widening hierarchy. Default: exact zone only, then equivalent zone via seatZone match. */
  allowZoneFallback?: boolean;
  maxLeadDistanceMinutes?: number;
};

export type Adequacy = 'sufficient' | 'limited' | 'insufficient';

export type BenchmarkResult = {
  methodVersion: string;
  representativeSnapshotIds: string[];
  representativeEventIds: string[];
  independentEventCount: number;
  medianCents: number | null;
  p25Cents: number | null;
  p75Cents: number | null;
  adequacy: Adequacy;
  adequacyReasons: string[];
  exclusions: Array<{ eventId: string; reason: string }>;
  fallbacksApplied: string[];
  licenseExpiresAt: Date | null;
  /** Whether the result may be shown to a customer (derived-data rights on every contributing dataset). */
  customerDisplayAllowed: boolean;
};

/** Type-7 quantile (linear interpolation), values need not be sorted. */
export function quantileType7(values: number[], p: number): number {
  if (values.length === 0) throw new RangeError('no values');
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

function contextMatches(a: EventContext, b: EventContext): string | null {
  if (a.entitySlug !== b.entitySlug) return 'different_entity';
  if (a.venueId !== b.venueId) return 'different_venue';
  if ((a.layoutVersion ?? null) !== (b.layoutVersion ?? null)) return 'different_layout_version';
  if (a.category !== b.category) return 'different_category';
  if ((a.subtype ?? null) !== (b.subtype ?? null)) return 'different_subtype'; // A48: preseason ≠ regular season
  if (a.isHome !== null && b.isHome !== null && a.isHome !== b.isHome) return 'home_away_mismatch';
  return null;
}

export function computeBenchmark(input: BenchmarkInput): BenchmarkResult {
  const exclusions: Array<{ eventId: string; reason: string }> = [];
  const fallbacksApplied: string[] = [];
  const targetBucket = leadBucket(input.targetLeadMinutes);
  const maxDistance = input.maxLeadDistanceMinutes ?? Number.POSITIVE_INFINITY;
  const seenExcluded = new Set<string>();
  const exclude = (eventId: string, reason: string) => {
    const k = `${eventId}:${reason}`;
    if (!seenExcluded.has(k)) {
      seenExcluded.add(k);
      exclusions.push({ eventId, reason });
    }
  };

  // Group candidate snapshots by event after applying hard cohort filters.
  const byEvent = new Map<string, HistoricalSnapshot[]>();
  let usedZoneFallback = false;
  let licenseExpiresAt: Date | null = null;
  let customerDisplayAllowed = true;

  for (const s of input.snapshots) {
    if (s.eventId === input.targetEventId) {
      exclude(s.eventId, 'target_event_excluded');
      continue;
    }
    if (s.isFixture && !input.allowFixtures) {
      exclude(s.eventId, 'fixture_data_not_admissible');
      continue;
    }
    if (!s.isFixture) {
      const ds = s.datasetId ? input.datasets[s.datasetId] : undefined;
      if (!ds) {
        exclude(s.eventId, 'no_dataset_rights');
        continue;
      }
      if (ds.status !== 'approved' || !ds.approvedUses.includes('benchmark')) {
        exclude(s.eventId, `dataset_${ds.status === 'approved' ? 'use_not_approved' : ds.status}`);
        continue;
      }
      if (ds.rawRetentionUntil && ds.rawRetentionUntil <= input.now) {
        exclude(s.eventId, 'dataset_retention_expired');
        continue;
      }
      if (!ds.approvedUses.includes('customer_display')) customerDisplayAllowed = false;
      const exp = ds.derivedRetentionUntil ?? ds.rawRetentionUntil;
      if (exp && (!licenseExpiresAt || exp < licenseExpiresAt)) licenseExpiresAt = exp;
    }
    const mismatch = contextMatches(input.targetContext, s.context);
    if (mismatch) {
      exclude(s.eventId, mismatch);
      continue;
    }
    if (s.quantity !== input.targetQuantity) {
      exclude(s.eventId, 'different_quantity'); // A49/A51: never substitute singles for the group
      continue;
    }
    if (input.targetSeatZone !== null) {
      if (s.seatZone !== input.targetSeatZone) {
        exclude(s.eventId, 'different_seat_zone');
        continue;
      }
      if (s.section === null || s.section === undefined) usedZoneFallback = true;
    }
    if (s.feeBasis !== 'verified_total') {
      exclude(s.eventId, 'fee_basis_not_verified');
      continue;
    }
    if (!s.coverageComplete) {
      exclude(s.eventId, 'coverage_incomplete');
      continue;
    }
    if (s.cheapestEligibleTotalCents === null) {
      exclude(s.eventId, 'no_eligible_group_offer');
      continue;
    }
    if (leadBucket(s.leadTimeMinutes) !== targetBucket) {
      exclude(s.eventId, 'lead_bucket_mismatch');
      continue;
    }
    if (Math.abs(s.leadTimeMinutes - input.targetLeadMinutes) > maxDistance) {
      exclude(s.eventId, 'lead_distance_exceeded');
      continue;
    }
    (byEvent.get(s.eventId) ?? byEvent.set(s.eventId, []).get(s.eventId)!).push(s);
  }
  if (usedZoneFallback && input.allowZoneFallback) fallbacksApplied.push('section_to_equivalent_zone');

  // One representative per event: the snapshot nearest the target lead time (A50).
  const reps: HistoricalSnapshot[] = [];
  for (const [, list] of byEvent) {
    list.sort((a, b) => Math.abs(a.leadTimeMinutes - input.targetLeadMinutes) - Math.abs(b.leadTimeMinutes - input.targetLeadMinutes) || a.id.localeCompare(b.id));
    reps.push(list[0]!);
  }
  reps.sort((a, b) => a.eventId.localeCompare(b.eventId));
  const values = reps.map((r) => r.cheapestEligibleTotalCents!);
  const n = reps.length;

  const adequacyReasons: string[] = [];
  let adequacy: Adequacy;
  if (n >= 10) adequacy = 'sufficient';
  else if (n >= 5) {
    adequacy = 'limited';
    adequacyReasons.push(`small_sample:${n}_events`);
  } else {
    adequacy = 'insufficient';
    adequacyReasons.push(`fewer_than_5_comparable_events:${n}`);
  }
  if (fallbacksApplied.length > 0) adequacyReasons.push(...fallbacksApplied.map((f) => `fallback:${f}`));

  const stats = n >= 5 ? { medianCents: quantileType7(values, 0.5), p25Cents: quantileType7(values, 0.25), p75Cents: quantileType7(values, 0.75) } : { medianCents: null, p25Cents: null, p75Cents: null };

  return {
    methodVersion: BENCHMARK_METHOD_VERSION,
    representativeSnapshotIds: reps.map((r) => r.id),
    representativeEventIds: reps.map((r) => r.eventId),
    independentEventCount: n,
    ...stats,
    adequacy,
    adequacyReasons,
    exclusions,
    fallbacksApplied,
    licenseExpiresAt,
    customerDisplayAllowed: n > 0 ? customerDisplayAllowed : false,
  };
}
