import type { HardConstraints, Offer, RequestExtraction } from './types';
import { wholePartyBudgetCents } from './money';
/**
 * Watch cadence, alert dedupe and re-alert rules (ENGINEERING_SPEC §8, A25).
 */
export const WATCH_MAX_DAYS = 30;
export const WATCH_MAX_ACTIVE_PER_CONTACT = 3;
export const WATCH_MAX_ALERTS_PER_DAY = 2;
export const REALERT_MIN_CENTS = 1000;
export const REALERT_MIN_PCT = 0.05;

export function cadenceMinutes(eventStartAt: Date, now: Date, opts: { lastMinuteApproved: boolean }): number | null {
  const hours = (eventStartAt.getTime() - now.getTime()) / 3_600_000;
  if (hours <= 0) return null;
  if (hours > 7 * 24) return 6 * 60;
  if (hours > 24) return 2 * 60;
  if (hours > 2) return 30;
  return opts.lastMinuteApproved ? 10 : null; // no last-minute promise without approved sources + staffing
}

export function watchExpiry(args: { now: Date; eventStartAt: Date; purchaseDeadline: Date | null }): Date {
  const cands = [new Date(args.now.getTime() + WATCH_MAX_DAYS * 86_400_000), args.eventStartAt];
  if (args.purchaseDeadline) cands.push(args.purchaseDeadline);
  return new Date(Math.min(...cands.map((d) => d.getTime())));
}

/**
 * One alert per watch generation, offer and exact total: the same price never alerts twice. Whether a different
 * price is worth another alert is the re-alert rule's call, against the lowest total already alerted in this
 * generation (`shouldAlert`), not the key's. A band key once did both, and its step grew with the price, so every
 * total above $200 fell in the same band and a $390 → $260 drop was a "duplicate" (PW-REPEAT-KEY-01).
 */
export function alertDedupeKey(args: { watchId: string; generation: number; offerIdentity: string; totalCents: number }): string {
  return `${args.watchId}:${args.generation}:${args.offerIdentity}:${Math.round(args.totalCents)}`;
}

export type AlertDecision = { alert: boolean; reason: string };

export function shouldAlert(args: {
  targetTotalCents: number;
  candidateTotalCents: number;
  candidateVerified: boolean;
  candidateFresh: boolean;
  lastAlertedTotalCents: number | null;
  alertsInLast24h: number;
  dedupeKeyExists: boolean;
}): AlertDecision {
  if (!args.candidateVerified) return { alert: false, reason: 'unverified_total_cannot_meet_threshold' }; // A08
  if (!args.candidateFresh) return { alert: false, reason: 'stale_observation' }; // A27
  return targetAndRepeats(args);
}

/** The target, dedupe, daily cap and re-alert rules, shared by seller and market alerts. */
function targetAndRepeats(args: { targetTotalCents: number; candidateTotalCents: number; lastAlertedTotalCents: number | null; alertsInLast24h: number; dedupeKeyExists: boolean }): AlertDecision {
  if (args.candidateTotalCents > args.targetTotalCents) return { alert: false, reason: 'above_target' };
  if (args.dedupeKeyExists) return { alert: false, reason: 'duplicate_alert_key' };
  if (args.alertsInLast24h >= WATCH_MAX_ALERTS_PER_DAY) return { alert: false, reason: 'daily_alert_cap' };
  if (args.lastAlertedTotalCents !== null) {
    // At least $10 AND at least 5% below the lowest total already alerted: the larger of the two (PW-REPEAT-CONTRACT-01).
    const reduction = args.lastAlertedTotalCents - args.candidateTotalCents;
    const needed = Math.max(REALERT_MIN_CENTS, Math.round(args.lastAlertedTotalCents * REALERT_MIN_PCT));
    if (reduction < needed) return { alert: false, reason: 'improvement_below_realert_threshold' };
  }
  return { alert: true, reason: 'qualified' };
}

/**
 * A SeatData market alert (DECISION_LOG #62): listed prices before fees, so never a verified total. The listed
 * total plus the fee allowance must fit the target, the listings must be recent, and the usual dedupe, daily cap
 * and re-alert rules apply to that estimate.
 */
export const MARKET_WATCH_MIN_CADENCE_MINUTES = 3 * 60;
/** A market point older than this is not "now" (SeatData rescans an event about every 8 hours). */
export const MARKET_ALERT_MAX_AGE_MINUTES = 3 * 60;
/** Clock skew allowed between the provider and us before a "future" refresh time is refused. */
export const MARKET_ALERT_FUTURE_TOLERANCE_MINUTES = 10;

export function marketEstimate(listedPerTicketCents: number, quantity: number, feeAllowancePct: number): { listedTotalCents: number; estimatedTotalCents: number } {
  const listedTotalCents = listedPerTicketCents * quantity;
  return { listedTotalCents, estimatedTotalCents: Math.round(listedTotalCents * (1 + feeAllowancePct / 100)) };
}

/**
 * `observedAt` is the provider's refresh time, never our fetch time (LAUNCH-06): a cached day-old read fetched now is
 * a day old. Undated, stale or future-dated reads can't be a "price hit now".
 */
export function shouldAlertMarket(args: { targetTotalCents: number; estimatedTotalCents: number; observedAt: Date | null; now: Date; lastAlertedTotalCents: number | null; alertsInLast24h: number; dedupeKeyExists: boolean }): AlertDecision {
  if (!args.observedAt) return { alert: false, reason: 'undated_observation' };
  const age = args.now.getTime() - args.observedAt.getTime();
  if (age < -MARKET_ALERT_FUTURE_TOLERANCE_MINUTES * 60_000) return { alert: false, reason: 'future_observation' };
  if (age > MARKET_ALERT_MAX_AGE_MINUTES * 60_000) return { alert: false, reason: 'stale_observation' };
  return targetAndRepeats({ ...args, candidateTotalCents: args.estimatedTotalCents });
}

/** A basket a market alert can honour: nothing beyond count, together and budget, which listings can't show. */
export function marketWatchable(b: ConstraintBasket): string | null {
  if (b.requireAccessible) return 'accessible_seating';
  if (b.acceptableSections?.length) return 'sections';
  if (b.deliveryBy) return 'delivery_deadline';
  if (b.unverifiable.length) return unverifiableReason(b.unverifiable[0]!);
  return null;
}

/** A stable reason code for an unverifiable requirement's label, for the audit (`market_unverifiable:<code>`). */
export function unverifiableReason(label: string): string {
  if (/age policy/i.test(label)) return 'age_rule';
  if (/entry/i.test(label)) return 'entry_rule';
  return 'requirement';
}

/**
 * Every hard requirement of a request revision, normalized once (service-depth F04). The watch stores it and
 * each evaluation uses it exactly as the first comparison did: accessible seating stays required, seats stay
 * together, a delivery deadline stays a deadline. What a listing can't show (an age policy, an entry rule) is
 * listed as unverifiable, and an unverifiable requirement means no actionable alert: unknown is never "meets it".
 */
export type ConstraintBasket = HardConstraints & {
  /** Adjacent pairs are enough (each child beside an adult), when they said so. */
  pairsOk: boolean;
  /** Tickets must be delivered by this instant; an offer with no stated delivery time can't show it. */
  deliveryBy: string | null;
  /** Hard requirements no listing field can confirm; any one stops an actionable alert. */
  unverifiable: string[];
  /** The request revision it was read from. */
  revision: number | null;
};

export function constraintBasket(
  brief: Pick<RequestExtraction, 'togetherRequired' | 'budgetCents' | 'budgetBasis' | 'accessibilityNeeds'>,
  quantity: number,
  eventStartAt: Date,
  extra: { acceptableSections?: string[] | null; pairsOk?: boolean; deliveryBy?: Date | null; unverifiable?: string[]; revision?: number | null } = {},
): ConstraintBasket {
  return {
    quantity,
    togetherRequired: brief.togetherRequired ?? null,
    budgetTotalCents: wholePartyBudgetCents(brief.budgetCents, brief.budgetBasis, quantity),
    excludeObstructedView: true,
    requireAccessible: !!brief.accessibilityNeeds?.trim(),
    acceptableSections: extra.acceptableSections ?? null,
    eventStartAt: eventStartAt.toISOString(),
    pairsOk: !!extra.pairsOk,
    deliveryBy: extra.deliveryBy ? extra.deliveryBy.toISOString() : null,
    unverifiable: extra.unverifiable ?? [],
    revision: extra.revision ?? null,
  };
}

/** A stored basket, or null when the row predates baskets (the caller then rebuilds it from the revision). */
export function readBasket(raw: unknown): ConstraintBasket | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<ConstraintBasket>;
  if (typeof b.quantity !== 'number' || typeof b.requireAccessible !== 'boolean' || typeof b.eventStartAt !== 'string') return null;
  return { togetherRequired: null, budgetTotalCents: null, excludeObstructedView: true, acceptableSections: null, pairsOk: false, deliveryBy: null, unverifiable: [], revision: null, ...b } as ConstraintBasket;
}

/** Offers that can show they meet the basket's delivery deadline; one with no stated delivery time can't. */
export function meetsDelivery(o: Pick<Offer, 'expectedDeliveryAt'>, b: Pick<ConstraintBasket, 'deliveryBy'>): boolean {
  if (!b.deliveryBy) return true;
  return !!o.expectedDeliveryAt && new Date(o.expectedDeliveryAt).getTime() <= new Date(b.deliveryBy).getTime();
}
