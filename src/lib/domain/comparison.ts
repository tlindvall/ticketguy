import type { HardConstraints, Offer } from './types';

/**
 * Deterministic eligibility and ranking (API_AND_DATA_CONTRACTS §3).
 * Nothing here reads affiliate fields. Unknown required properties are flagged for review, never passed.
 */

export type ExclusionReason =
  | 'wrong_event'
  | 'wrong_quantity'
  | 'parking_only'
  | 'different_session'
  | 'resale_deposit'
  | 'vip_package'
  | 'obstructed_view'
  | 'not_accessible'
  | 'section_not_acceptable'
  | 'seats_not_together'
  | 'unavailable'
  | 'over_budget'
  | 'currency';

export type ReviewFlag = 'adjacency_unknown' | 'fees_unknown' | 'tax_unknown' | 'delivery_unknown' | 'availability_unknown' | 'estimated_total';

export type Evaluated = {
  offer: Offer;
  verdict: 'eligible' | 'needs_review' | 'excluded';
  exclusions: ExclusionReason[];
  flags: ReviewFlag[];
  /** Total used for ranking; null when incomplete. */
  comparableTotalCents: number | null;
};

const EXCLUDING_RESTRICTIONS: Record<string, ExclusionReason> = {
  parking_only: 'parking_only',
  different_session: 'different_session',
  wrong_session: 'different_session',
  resale_deposit: 'resale_deposit',
  vip_package: 'vip_package',
  unrelated_package: 'vip_package',
};

export function evaluateOffer(offer: Offer, c: HardConstraints, eventId: string): Evaluated {
  const exclusions: ExclusionReason[] = [];
  const flags: ReviewFlag[] = [];

  if (offer.eventId !== eventId) exclusions.push('wrong_event');
  if (offer.quantity !== c.quantity) exclusions.push('wrong_quantity');
  if (offer.currency !== 'USD') exclusions.push('currency');
  for (const r of offer.restrictions) {
    const ex = EXCLUDING_RESTRICTIONS[r];
    if (ex && !exclusions.includes(ex)) exclusions.push(ex);
  }
  if (c.excludeObstructedView && offer.restrictions.includes('obstructed_view')) exclusions.push('obstructed_view');
  if (c.requireAccessible && !offer.restrictions.includes('accessible_seating')) exclusions.push('not_accessible');
  if (c.acceptableSections && offer.section && !c.acceptableSections.map((s) => s.toLowerCase()).includes(offer.section.toLowerCase())) {
    exclusions.push('section_not_acceptable');
  }
  if (c.togetherRequired && c.quantity > 1) {
    if (offer.seatsTogether === false) exclusions.push('seats_not_together');
    else if (offer.seatsTogether === null && offer.admissionType === 'reserved') flags.push('adjacency_unknown');
  }
  if (offer.availability === 'unavailable') exclusions.push('unavailable');
  if (offer.availability === 'unknown') flags.push('availability_unknown');

  // Whole-party payable total. Null components are never treated as zero.
  let total: number | null = offer.payableTotalCents;
  if (total === null) {
    if (offer.baseTotalCents !== null && offer.mandatoryFeeTotalCents !== null && offer.taxTotalCents !== null && offer.deliveryTotalCents !== null) {
      total = offer.baseTotalCents + offer.mandatoryFeeTotalCents + offer.taxTotalCents + offer.deliveryTotalCents;
    }
  }
  if (offer.mandatoryFeeTotalCents === null && offer.payableTotalCents === null) flags.push('fees_unknown');
  if (offer.taxTotalCents === null && offer.payableTotalCents === null) flags.push('tax_unknown');
  if (offer.deliveryTotalCents === null && offer.payableTotalCents === null && offer.deliveryMethod === null) flags.push('delivery_unknown');
  if (offer.priceCompleteness !== 'verified_total') flags.push('estimated_total');

  if (c.budgetTotalCents !== null && total !== null && total > c.budgetTotalCents) exclusions.push('over_budget');

  const verdict = exclusions.length > 0 ? 'excluded' : flags.length > 0 ? 'needs_review' : 'eligible';
  return { offer, verdict, exclusions, flags, comparableTotalCents: total };
}

export type ComparisonResult = {
  eligible: Evaluated[]; // sorted cheapest verified whole-party total, then freshness, then delivery certainty
  needsReview: Evaluated[];
  excluded: Evaluated[];
  /** Grouped by seat class so better-seat alternatives are never disguised as the cheapest equivalent. */
  groups: Record<string, Evaluated[]>;
  possibleDuplicates: Array<[string, string]>;
};

function rank(a: Evaluated, b: Evaluated): number {
  const ta = a.comparableTotalCents ?? Number.MAX_SAFE_INTEGER;
  const tb = b.comparableTotalCents ?? Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  const fa = Date.parse(a.offer.observedAt);
  const fb = Date.parse(b.offer.observedAt);
  if (fa !== fb) return fb - fa; // fresher first
  const da = a.offer.deliveryMethod ? 0 : 1;
  const db = b.offer.deliveryMethod ? 0 : 1;
  if (da !== db) return da - db;
  return a.offer.id.localeCompare(b.offer.id);
}

export function compareOffers(offers: Offer[], c: HardConstraints, eventId: string): ComparisonResult {
  const evaluated = offers.map((o) => evaluateOffer(o, c, eventId));
  const eligible = evaluated.filter((e) => e.verdict === 'eligible').sort(rank);
  const needsReview = evaluated.filter((e) => e.verdict === 'needs_review').sort(rank);
  const excluded = evaluated.filter((e) => e.verdict === 'excluded');
  const groups: Record<string, Evaluated[]> = {};
  for (const e of [...eligible, ...needsReview]) {
    const key = e.offer.seatClass ?? e.offer.admissionType;
    (groups[key] ??= []).push(e);
  }
  // Section/row/quantity similarity is a duplicate *hint*; never a claim of identical inventory (A10).
  const possibleDuplicates: Array<[string, string]> = [];
  const candidates = [...eligible, ...needsReview];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!.offer;
      const b = candidates[j]!.offer;
      if (a.sourceId !== b.sourceId && a.section && a.section === b.section && a.row === b.row && a.quantity === b.quantity) {
        possibleDuplicates.push([a.id, b.id]);
      }
    }
  }
  return { eligible, needsReview, excluded, groups, possibleDuplicates };
}

/**
 * Count of independent qualifying options is only reportable when duplicates are ruled out.
 * Returns null when identity is uncertain (A10, A54).
 */
export function independentOptionCount(result: ComparisonResult): number | null {
  if (result.possibleDuplicates.length > 0) return null;
  return result.eligible.length;
}

/** Savings claim requires a verified comparable baseline (A08). */
export function verifiedSavings(baseline: Offer | null, best: Evaluated | null): number | null {
  if (!baseline || !best || best.verdict !== 'eligible') return null;
  if (baseline.priceCompleteness !== 'verified_total' || baseline.payableTotalCents === null) return null;
  if (best.offer.priceCompleteness !== 'verified_total' || best.comparableTotalCents === null) return null;
  if (baseline.quantity !== best.offer.quantity || baseline.eventId !== best.offer.eventId) return null;
  return baseline.payableTotalCents - best.comparableTotalCents;
}
