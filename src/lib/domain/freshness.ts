/**
 * Send-time freshness (ENGINEERING_SPEC §6): revalidated within 5 minutes for events <24h away,
 * otherwise 15 minutes. A source's own as-of timestamp overrides a fresh fetch of a cached feed.
 */
export const FRESHNESS_POLICY_VERSION = '1';

export function freshnessWindowMinutes(eventStartAt: Date, now: Date): number {
  const hoursToEvent = (eventStartAt.getTime() - now.getTime()) / 3_600_000;
  return hoursToEvent < 24 ? 5 : 15;
}

export type FreshnessVerdict = { fresh: boolean; ageMinutes: number; windowMinutes: number; reason: string | null };

export function checkFreshness(args: { fetchedAt: Date; sourceAsOf: Date | null; eventStartAt: Date; now: Date }): FreshnessVerdict {
  const windowMinutes = freshnessWindowMinutes(args.eventStartAt, args.now);
  const effective = args.sourceAsOf && args.sourceAsOf < args.fetchedAt ? args.sourceAsOf : args.fetchedAt;
  const ageMinutes = (args.now.getTime() - effective.getTime()) / 60_000;
  if (ageMinutes < 0) return { fresh: false, ageMinutes, windowMinutes, reason: 'observation_in_future' };
  if (ageMinutes > windowMinutes) {
    return {
      fresh: false,
      ageMinutes,
      windowMinutes,
      reason: args.sourceAsOf && args.sourceAsOf < args.fetchedAt ? 'source_data_stale' : 'observation_stale',
    };
  }
  return { fresh: true, ageMinutes, windowMinutes, reason: null };
}
