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

/** Price band: bucket by max($10, 5%) so oscillation inside a band does not re-alert. */
export function priceBand(totalCents: number): number {
  const step = Math.max(REALERT_MIN_CENTS, Math.round(totalCents * REALERT_MIN_PCT));
  return Math.floor(totalCents / step);
}

export function alertDedupeKey(args: { watchId: string; generation: number; offerIdentity: string; totalCents: number }): string {
  return `${args.watchId}:${args.generation}:${args.offerIdentity}:${priceBand(args.totalCents)}`;
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
  if (args.candidateTotalCents > args.targetTotalCents) return { alert: false, reason: 'above_target' };
  if (args.dedupeKeyExists) return { alert: false, reason: 'duplicate_alert_key' };
  if (args.alertsInLast24h >= WATCH_MAX_ALERTS_PER_DAY) return { alert: false, reason: 'daily_alert_cap' };
  if (args.lastAlertedTotalCents !== null) {
    const reduction = args.lastAlertedTotalCents - args.candidateTotalCents;
    const needed = Math.max(REALERT_MIN_CENTS, Math.round(args.lastAlertedTotalCents * REALERT_MIN_PCT));
    if (reduction < needed) return { alert: false, reason: 'improvement_below_realert_threshold' };
  }
  return { alert: true, reason: 'qualified' };
}
