import { describe, expect, it } from 'vitest';
import { computeTrend, type TrendObservation } from '@/lib/advice/trend';
import { trendRights, type TrendDatasetRights } from '@/lib/advice/trend-rights';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import { suppliedEvidenceAnswer } from '@/lib/advice/supplied-evidence';
import type { MarketContext } from '@/lib/market/series';

/**
 * Research 2 (Sep 30 2026) engine controls, as positive and negative pairs. Inputs are rebuilt from the report's
 * descriptions; LOCAL_ENGINE_CONTROLS.json wasn't available here.
 */
const NOW = new Date('2026-09-30T16:00:00Z');
const H = 3_600_000;
const obs = (id: string, hoursAgo: number, cents: number, shiftHours = 0): TrendObservation => ({ id, observedAt: new Date(NOW.getTime() - (hoursAgo - shiftHours) * H), basketKey: 'five-upper', cheapestEligibleTotalCents: cents, sourceIds: ['s1'], feeBasis: 'verified_total', coverageComplete: true, qualityFlags: [] });
// The report's working control: five seats, upper zone, fees included, $450 → $500 over a day.
const rising = (shift = 0) => [obs('a', 24, 45000, shift), obs('b', 12, 46500, shift), obs('c', 6, 48000, shift), obs('d', 0, 50000, shift)];

describe('R2-TREND-TIME-01: a trend is current only when its newest observation is', () => {
  it('positive control: a fresh series is an upward, sufficient, current trend with its latest observation time', () => {
    const r = computeTrend(rising(), NOW);
    expect(r).toMatchObject({ direction: 'up', adequacy: 'sufficient', freshness: 'current', historical: null });
    expect(r.latestObservedAt).toEqual(NOW);
  });
  it('the same series ending 14 days ago is history: insufficient for timing, with its real dates kept', () => {
    const r = computeTrend(rising(-14 * 24), NOW);
    expect(r.adequacy).toBe('insufficient');
    expect(r.direction).toBe('insufficient');
    expect(r.freshness).toBe('historical');
    expect(r.reasons).toContain('endpoint_stale:336h');
    expect(r.historical).toMatchObject({ fromCents: 45000, toCents: 50000, direction: 'up' });
    expect(r.historical!.toAt).toEqual(new Date(NOW.getTime() - 14 * 24 * H));
  });
  it('a series entirely in the future is not evidence at all', () => {
    const r = computeTrend(rising(48), NOW);
    expect(r.adequacy).toBe('insufficient');
    expect(r.validObservationIds).toEqual([]);
    expect(r.reasons).toContain('future_observations_excluded:4');
  });
  it('one future point beside a fresh series is dropped, and the rest still counts', () => {
    const r = computeTrend([...rising(), obs('future', -48, 30000)], NOW);
    expect(r).toMatchObject({ direction: 'up', adequacy: 'sufficient' });
    expect(r.validObservationIds).not.toContain('future');
    expect(r.qualityFlags).toContain('future_observation');
  });
  it('a fresh endpoint keeps its valid 72-hour baseline; observations older than the lookback don’t steer it', () => {
    const r = computeTrend([obs('old', 24 * 10, 90000), obs('h72', 72, 44000), ...rising()], NOW);
    expect(r.adequacy).toBe('sufficient');
    expect(r.windows.h72?.baselineObservationId).toBe('h72');
    expect(r.validObservationIds).not.toContain('old');
  });

  const packetArgs = (trend: ReturnType<typeof computeTrend>) => ({
    requestId: 'r', revision: 1, quantity: 5, eventLabel: 'x', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend, trendRunId: 't',
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false },
    sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: null, observedAt: NOW, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false, market: null, timeZone: 'America/New_York',
  }) as unknown as BuildPacketArgs;
  const claim = (trend: ReturnType<typeof computeTrend>, id: string) => buildPacket(packetArgs(trend)).claimRecords.find((c) => c.id === id);

  it('the visible claim: an old series is described with its dates and never as "the last 24 hours"', () => {
    const old = computeTrend(rising(-14 * 24), NOW);
    expect(claim(old, 'C_TREND')).toBeUndefined();
    const text = claim(old, 'C_NOTREND')!.text;
    expect(text).toContain('The newest comparable price I have for your group is from Sep 16');
    expect(text).toContain('too old to say how prices are moving now');
    expect(text).toContain('from $450 to $500');
    expect(text).not.toMatch(/last \d+ hours/);
  });
  it('a current trend whose newest point is hours old names that time, and the claim carries it', () => {
    const fresh = computeTrend(rising(), NOW);
    expect(claim(fresh, 'C_TREND')!.text).toContain('over the last 24 hours');
    const lagged = computeTrend(rising(-5), NOW);
    const c = claim(lagged, 'C_TREND')!;
    expect(c.text).toContain('in the 24 hours up to Sep 30, 7:00 AM EDT');
    expect(c.scope.observedAt).toBe(new Date(NOW.getTime() - 5 * H).toISOString());
  });
  it('a trend without display rights is used in advice but not shown', () => {
    const fresh = computeTrend(rising(), NOW);
    const p = buildPacket({ ...packetArgs(fresh), trendDisplayAllowed: false });
    expect(p.claimRecords.find((c) => c.id === 'C_TREND')!.customerVisible).toBe(false);
  });
});

describe('R2-TREND-RIGHTS-01: a trend comes only from data it is permitted to use', () => {
  const snaps = [1, 2, 3, 4].map((i) => ({ id: `s${i}`, datasetId: 'ds', isFixture: false }));
  const ds = (over: Partial<TrendDatasetRights>): Map<string, TrendDatasetRights> => new Map([['ds', { id: 'ds', status: 'approved', approvedUses: ['tracking', 'advice', 'customer_display'], rawRetentionUntil: null, derivedRetentionUntil: null, isFixture: false, ...over }]]);
  const run = (over: Partial<TrendDatasetRights>, fixtureWorld = false) => trendRights(snaps, ds(over), { now: NOW, fixtureWorld });

  it('positive control: an approved dataset with advice and display rights admits every snapshot', () => {
    expect(run({})).toMatchObject({ displayAllowed: true, excluded: [] });
    expect(run({}).admitted.size).toBe(4);
  });
  it.each([
    ['revoked', { status: 'revoked' }, 'dataset_revoked'],
    ['quarantined', { status: 'quarantined' }, 'dataset_quarantined'],
    ['expired status', { status: 'expired' }, 'dataset_expired'],
    ['retention ended', { rawRetentionUntil: new Date(NOW.getTime() - H) }, 'dataset_retention_expired'],
    ['no advice use', { approvedUses: ['tracking', 'customer_display'] }, 'dataset_use_not_approved'],
  ] as const)('%s: nothing is admitted', (_label, over, reason) => {
    const v = run(over as Partial<TrendDatasetRights>);
    expect(v.admitted.size).toBe(0);
    expect(v.displayAllowed).toBe(false);
    expect(new Set(v.excluded.map((e) => e.reason))).toEqual(new Set([reason]));
  });
  it('advice without customer display: derived, not shown', () => {
    expect(run({ approvedUses: ['tracking', 'advice'] })).toMatchObject({ displayAllowed: false });
    expect(run({ approvedUses: ['tracking', 'advice'] }).admitted.size).toBe(4);
  });
  it('a snapshot with no dataset record has no rights', () => {
    expect(trendRights([{ id: 'x', datasetId: null, isFixture: false }], new Map(), { now: NOW, fixtureWorld: false }).excluded).toEqual([{ id: 'x', reason: 'no_dataset_rights' }]);
  });
  it('fixture data is isolated: admitted only in the fixture world, and never through a real dataset', () => {
    const fx = [{ id: 'f', datasetId: null, isFixture: true }];
    expect(trendRights(fx, new Map(), { now: NOW, fixtureWorld: false }).excluded[0]!.reason).toBe('fixture_data_not_admissible');
    expect(trendRights(fx, new Map(), { now: NOW, fixtureWorld: true }).admitted.has('f')).toBe(true);
    expect(trendRights([{ id: 'f', datasetId: 'ds', isFixture: true }], ds({}), { now: NOW, fixtureWorld: true }).excluded[0]!.reason).toBe('fixture_row_in_real_dataset');
  });
});

describe('R2-SUPPLY-COPY-01: falling prices never stand in for supply', () => {
  const at = new Date(NOW.getTime() - 30 * 60_000);
  const ctx = (supply: MarketContext['supply']): MarketContext => ({ methodVersion: 'm', basis: 'group:5' as MarketContext['basis'], zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 9000, at, activeListings: supply.now }, h24: { hours: 24, fromCents: 10000, toCents: 9000, changeCents: -1000, pct: -0.1 }, h72: { hours: 72, fromCents: 11000, toCents: 9000, changeCents: -2000, pct: -0.18 }, direction: 'down', supply, typical: null, points: 12 });
  // A customer who accepts wait risk and has a deadline: the case where the old copy said "plenty to choose from".
  const read = (supply: MarketContext['supply']) => {
    const m = ctx(supply);
    const p = buildPacket({
      requestId: 'r', revision: 1, quantity: 5, eventLabel: 'x', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
      policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
      priorities: { mustAttend: false, waitRiskTolerance: 'high', decisionDeadline: new Date('2026-10-10T16:00:00Z'), budgetTotalCents: null, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
      sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: null, observedAt: NOW, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false, timeZone: 'America/New_York',
      market: { basis: 'group:5', context: m, supply, supplyScope: 'group', comparableLabel: null, visible: true },
    } as unknown as BuildPacketArgs);
    return p.claimRecords.filter((c) => c.customerVisible).map((c) => c.text).join('\n');
  };

  it('one listing (1 → 1): thin-supply caution, no abundance, no "no need to rush", singular "listing"', () => {
    const text = read({ trend: 'stable', now: 1, before: 1, hours: 24 });
    expect(text).toContain('there was only 1 listing with five or more tickets when I checked, so I wouldn’t count on waiting');
    expect(text).toContain('About 1 listing has 5 or more tickets');
    expect(text).not.toMatch(/plenty|no need to rush|1 listings/);
  });
  it('unknown counts: unknown supply said as unknown, with the risk and the deadline kept', () => {
    const text = read({ trend: 'unknown', now: null, before: null, hours: null });
    expect(text).toContain('I can’t see how many listings there are for a group your size, so that alone isn’t a reason to wait');
    expect(text).toContain('I’d decide by Oct 10');
    expect(text).not.toMatch(/plenty|no need to rush/);
  });
  it('positive control (100 → 100): the count is described with its quantity limits, never as a promise', () => {
    const text = read({ trend: 'stable', now: 100, before: 100, hours: 24 });
    expect(text).toContain('there were 100 listings with five or more tickets when I checked (some may not split into exactly your number or sit together)');
    expect(text).toContain('Waiting by Oct 10 is reasonable if you’re ok with the risk that the seats you want go');
    expect(text).not.toMatch(/plenty|no need to rush/);
  });
});

describe('R2-EVIDENCE-01: what the analysis route answers and what it leaves alone', () => {
  it('leaves ordinary event requests and labelled offer comparisons to their own paths', () => {
    expect(suppliedEvidenceAnswer(['Two tickets for Knicks vs Celtics at MSG on Saturday, $300 total.'])).toBeNull();
    expect(suppliedEvidenceAnswer(['Offer A: $100 per ticket before fees. Offer B: $125 per ticket all-in. Which should I buy for two?'])).toBeNull();
    expect(suppliedEvidenceAnswer(['How much are Taylor Swift tickets today?'])).toBeNull();
    // Counts that aren't a change, and a new request after an answered one.
    expect(suppliedEvidenceAnswer(['There are 3 listings in section 101 and 2 in section 102. Which is better?'])).toBeNull();
    expect(suppliedEvidenceAnswer(['Active listings went from 100 yesterday to 70 today.', 'Thanks! Can you find me two Knicks tickets for Saturday?'])).toBeNull();
    expect(suppliedEvidenceAnswer(['Active listings went from 100 yesterday to 70 today.', 'What does that mean?'])?.lead).toMatch(/^Listings fell by 30/);
  });
  it('incompatible baskets: two group totals for different numbers of seats show no price change', () => {
    const r = suppliedEvidenceAnswer(['We need adjacent seats. Yesterday five seats together were $450 total, today four seats together are $380 total. Did the price drop?'])!;
    expect(r.lead).toBe('Those two totals are for different numbers of seats, so they can’t show a price change.');
    expect(r.items.join(' ')).not.toMatch(/\$70|cheaper|dropped/);
  });
  it('incompatible baskets: a single seat against five seats is not one basket at two times', () => {
    const r = suppliedEvidenceAnswer(['Yesterday a single upper-level seat was $80 before fees, today five upper-level seats are $110 each all-in. Is it cheaper now?'])!;
    expect(r.lead).toBe('Those two quotes are for different seats, so they can’t show whether prices went up or down.');
  });
  it('missing provenance: a sales count with no named source is still only the customer’s figure', () => {
    const r = suppliedEvidenceAnswer(['Active listings went from 100 yesterday to 70 today.', 'Apparently 12 orders and 24 tickets sold.'])!;
    expect(r.items.join(' ')).toContain('Those figures are yours; I haven’t checked where they come from or how they count.');
    expect(r.items.join(' ')).not.toContain('Your separate report');
  });
});

// Research2 post-deploy (Oct 1 2026) acceptance: equivalent wording and negatives beside the exact live replays
// in tests/acceptance/research2-evidence.test.ts.
describe('R2-EVIDENCE-*-FOLLOWUP-01: follow-up figures are read in their own units', () => {
  const opening = 'Yesterday the cheapest single ticket was $90 including fees; today it\'s $60 including fees. We need FIVE reserved seats together in the same upper-tier zone. Should we wait?';
  it('"all-in" is the same basis as "including fees" for a group', () => {
    const r = suppliedEvidenceAnswer([opening, 'For five adjacent reserved seats: yesterday $450 all-in; today $500 all-in. What changed for our group?']);
    expect(r?.kinds).toEqual(['group_change']);
    expect(r?.lead).toBe('For your five seats, the total rose $50: $450 to $500 with fees included (11.1% more).');
  });
  it('a group quoted before fees and then with fees is not a price change', () => {
    const r = suppliedEvidenceAnswer([opening, 'For five adjacent reserved seats: yesterday $450 before fees; today $500 including fees. What changed?']);
    expect(r?.kinds).not.toEqual(['group_change']);
    expect(r?.lead).not.toMatch(/rose \$50/);
  });
  it('the time word nearest each total decides its order, not the sentence’s first', () => {
    const r = suppliedEvidenceAnswer([opening, 'Now here are five adjacent seats: yesterday $500 including fees; today $450 including fees.']);
    expect(r?.lead).toBe('For your five seats, the total fell $50: $500 to $450 with fees included (10% less).');
  });
  const listings = 'A listing feed showed 100 active listings yesterday and 70 today. Can you say 30 tickets sold?';
  it.each([
    ['12 completed orders for 24 tickets', 'I have a separate report recording 12 completed orders for 24 tickets.'],
    ['12 orders for 24 tickets', 'A separate report records 12 orders for 24 tickets.'],
  ])('%s is a sales report beside the listing change', (_label, report) => {
    const r = suppliedEvidenceAnswer([listings, `${report} Can we say those 30 fewer listings were 30 sales?`]);
    expect(r?.kinds).toEqual(['listings_vs_sales']);
    expect(r?.lead).toBe('Your report records 12 orders covering 24 tickets; that doesn’t show thirty fewer listings were thirty sales.');
    expect(r?.items[0]).toMatch(/^The listing count still fell from 100 to 70\./);
  });
  it('a question’s numbers never replace the observed counts', () => {
    const r = suppliedEvidenceAnswer([listings, 'Were those 30 fewer listings now 30 sales?']);
    expect(r?.lead ?? '').not.toMatch(/30 both times|didn’t change/);
  });
});
