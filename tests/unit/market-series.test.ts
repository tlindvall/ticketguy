import { describe, expect, it } from 'vitest';
import { basisForQuantity, computeMarketContext, pointsFromListings, pointsFromSnapshot, providerTime, typicalAtLead, marketBasketKey } from '@/lib/market/series';
import { decide } from '@/lib/advice/policy';
import { marketDecision, pollIntervalMinutes } from '@/lib/market/tracker';

const H = 3_600_000;
const now = new Date('2026-09-22T15:00:00Z');
const start = new Date('2026-10-30T23:00:00Z');
const series = (from: number, to: number, listingsFrom = 400, listingsTo = 400, hours = 96, every = 4) =>
  Array.from({ length: hours / every + 1 }, (_, i) => {
    const f = i / (hours / every);
    return { observedAt: new Date(now.getTime() - (hours - i * every) * H), priceCents: Math.round(from + (to - from) * f), activeListings: Math.round(listingsFrom + (listingsTo - listingsFrom) * f) };
  });

describe('market series', () => {
  it('reads a provider snapshot into single and pair points, overall and per zone, skipping empty prices', () => {
    const pts = pointsFromSnapshot({ timestamp: '2026-09-22T14:30:00Z', total_listings_all: 500, total_listings_active: 312, listing_fill_rate: 0.6, avg_price: 245.5, median_price: 198, get_in: 89, get_in_qty2plus: 145, zones: [{ zone_name: 'Lower Bowl', avg_price: 300, median_price: 280, get_in: 150, get_in_qty2plus: null }] });
    // The provider's snapshot time dates the point; no fetch time was given.
    const at = new Date('2026-09-22T14:30:00Z');
    const d = { observedAt: at, providerAsOf: at, retrievedAt: null };
    expect(pts).toEqual([
      { basis: 'single', zone: null, ...d, priceCents: 8900, medianCents: 19800, activeListings: 312 },
      { basis: 'pair', zone: null, ...d, priceCents: 14500, medianCents: 19800, activeListings: 312 },
      { basis: 'single', zone: 'Lower Bowl', ...d, priceCents: 15000, medianCents: 28000, activeListings: null },
    ]);
    expect(pointsFromSnapshot({ timestamp: 'garbage' } as never)).toEqual([]);
  });

  it('one and two tickets read the stats series; three or more read their own group series, capped at 12', () => {
    expect([1, 2, 3, 5, 20].map(basisForQuantity)).toEqual(['single', 'pair', 'group:3', 'group:5', 'group:12']);
    expect(marketBasketKey('e1', 'group:5', null)).not.toBe(marketBasketKey('e1', 'group:4', null));
    expect(marketBasketKey('e1', 'single', null)).not.toBe(marketBasketKey('e1', 'pair', null));
  });

  it('calls a fall, with windows, when prices drop and listings hold', () => {
    const c = computeMarketContext({ basis: 'pair', zone: null, points: series(15000, 12000), now, eventStartAt: start });
    expect(c.adequacy).toBe('sufficient');
    expect(c.direction).toBe('down');
    expect(c.h72!.fromCents).toBe(14250);
    expect(c.current!.priceCents).toBe(12000);
    expect(c.supply.trend).toBe('stable');
  });

  it('small moves are flat; rises are up', () => {
    expect(computeMarketContext({ basis: 'single', zone: null, points: series(10000, 9900), now, eventStartAt: start }).direction).toBe('flat');
    expect(computeMarketContext({ basis: 'single', zone: null, points: series(10000, 13000), now, eventStartAt: start }).direction).toBe('up');
  });

  it('sees listings shrinking even while prices fall', () => {
    const c = computeMarketContext({ basis: 'pair', zone: null, points: series(15000, 12000, 400, 200), now, eventStartAt: start });
    expect(c.direction).toBe('down');
    expect(c.supply).toMatchObject({ trend: 'shrinking', now: 200 });
    expect(marketDecision(c)).toEqual({ decision: 'buy', reasons: ['direction_down', 'supply_shrinking', 'listings_shrinking'] });
  });

  it('refuses to call anything on too few, too short or stale data', () => {
    expect(computeMarketContext({ basis: 'single', zone: null, points: series(15000, 12000).slice(-3), now, eventStartAt: start }).adequacy).toBe('insufficient');
    // A day old is too old; half a day is SeatData's normal cadence, not staleness (the Rangers card said "13 h ago").
    expect(computeMarketContext({ basis: 'single', zone: null, points: series(15000, 12000), now: new Date(now.getTime() + 13 * H), eventStartAt: start }).adequacy).toBe('sufficient');
    const stale = computeMarketContext({ basis: 'single', zone: null, points: series(15000, 12000), now: new Date(now.getTime() + 30 * H), eventStartAt: start });
    expect(stale.adequacy).toBe('insufficient');
    expect(stale.reasons.some((r) => r.startsWith('stale'))).toBe(true);
  });

  it('typical price at this lead time needs five comparable games, one value each', () => {
    const lead = 30 * 24 * 60 + 60;
    const four = [1, 2, 3, 4].map((i) => ({ eventKey: `g${i}`, leadMinutes: lead, priceCents: 5000 + i * 1000 }));
    expect(typicalAtLead(four, lead)).toBeNull();
    const five = [...four, { eventKey: 'g5', leadMinutes: lead, priceCents: 10000 }, { eventKey: 'g5', leadMinutes: lead + 30, priceCents: 99999 }];
    expect(typicalAtLead(five, lead)).toMatchObject({ events: 5, medianCents: 8000, p25Cents: 7000, p75Cents: 9000 });
  });

  it('polls daily beyond a week, twice a day in the last week, every 6 hours in the last two days, twice as often after a big move', () => {
    expect(pollIntervalMinutes(40 * 24 * 60, null)).toBe(24 * 60);
    expect(pollIntervalMinutes(4 * 24 * 60, null)).toBe(12 * 60);
    expect(pollIntervalMinutes(4 * 24 * 60, -0.15)).toBe(6 * 60);
    expect(pollIntervalMinutes(12 * 60, null)).toBe(6 * 60);
    expect(pollIntervalMinutes(12 * 60, 0.2)).toBe(3 * 60);
  });

  it('listings become one point per group size: the cheapest active listing with at least that many tickets, and how many there are', () => {
    const at = new Date('2026-10-01T12:00:00Z');
    const listings = [
      { active: true, listing_id: 1, price: 95, quantity: 2 },
      { active: true, listing_id: 2, price: 140, quantity: 6 },
      { active: true, listing_id: 3, price: 155.5, quantity: 5 },
      { active: false, listing_id: 4, price: 60, quantity: 8 },
      { active: 1, listing_id: 5, price: '120', quantity: 4 },
      { listing_id: 6, price: null, quantity: 9 },
      { listing_id: 7, price: 200, quantity: 'many' },
    ];
    const pts = pointsFromListings(listings, [5, 4, 5, 2, 9], at);
    expect(pts.map((p) => [p.basis, p.priceCents, p.medianCents, p.activeListings])).toEqual([
      ['group:4', 12000, 14000, 3],
      ['group:5', 14000, 15550, 2],
    ]);
    // No provider time given: dated by the fetch, and marked as undated.
    expect(pts.every((p) => p.observedAt === at && p.retrievedAt === at && p.providerAsOf === null && p.zone === null)).toBe(true);
    // Nothing big enough: no point, rather than a made-up price.
    expect(pointsFromListings(listings, [10], at)).toEqual([]);
  });
});

describe('group floors ignore seats that are not for an ordinary buyer', () => {
  it('a wheelchair block or parking pass never sets the "5 or more from" price', async () => {
    const { pointsFromListings } = await import('@/lib/market/series');
    const at = new Date('2026-09-29T12:00:00Z');
    const pts = pointsFromListings([
      { active: true, price: 45, quantity: 6, section: 'ADA 111', row: 'WC' },
      { active: true, price: 30, quantity: 8, section: 'Parking Lot C' },
      { active: true, price: 120, quantity: 6, section: '212', row: 'D' },
      { active: true, price: 140, quantity: 5, section: '224', row: 'F', zone: 'Upper Level' },
    ], [5], at);
    // The venue, then each zone the ordinary listings name.
    expect(pts.map((p) => [p.zone, p.priceCents, p.activeListings])).toEqual([[null, 12000, 2], ['Upper Level', 14000, 1]]);
  });
});

describe('TREND-2327-01: no comparison window is no trend', () => {
  const now = new Date('2026-10-02T23:50:00Z');
  const series = (hours: number[], prices: number[]) => hours.map((h, i) => ({ observedAt: new Date(now.getTime() + h * H), priceCents: prices[i]!, activeListings: 50 }));
  const ctx = (hours: number[], prices: number[]) => computeMarketContext({ basis: 'pair', zone: 'Floor', points: series(hours, prices), now, eventStartAt: new Date(now.getTime() + 48 * H) });

  it('a 30% fall over 12 hours, with no 24- or 72-hour baseline, is insufficient, never "flat"', () => {
    const c = ctx([-12, -8, -4, 0], [10000, 9000, 8000, 7000]);
    expect(c).toMatchObject({ adequacy: 'insufficient', direction: 'insufficient', h24: null, h72: null });
    expect(c.reasons).toContain('no_comparison_window');
    // The newest price is still known and said.
    expect(c.current?.priceCents).toBe(7000);
  });

  it('the same for a rise, and a held price, over 12 hours', () => {
    expect(ctx([-12, -8, -4, 0], [7000, 8000, 9000, 10000]).direction).toBe('insufficient');
    expect(ctx([-12, -8, -4, 0], [9000, 9000, 9000, 9000]).direction).toBe('insufficient');
  });

  it('with a real 24-hour window the direction is read as before', () => {
    expect(ctx([-24, -16, -8, 0], [10000, 9000, 8000, 7000])).toMatchObject({ adequacy: 'sufficient', direction: 'down' });
    expect(ctx([-24, -16, -8, 0], [9000, 9000, 9000, 9000])).toMatchObject({ adequacy: 'sufficient', direction: 'flat' });
  });
});

describe('TREND-ACC: provider time, repeated reads, mixed movement', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const at = (h: number) => new Date(now.getTime() + h * H);

  it('reads the provider refresh time in seconds, milliseconds or ISO, and treats missing or impossible times as unknown', () => {
    expect(providerTime(Math.floor(at(-5).getTime() / 1000), now)).toEqual(at(-5));
    expect(providerTime(at(-5).getTime(), now)).toEqual(at(-5));
    expect(providerTime(String(Math.floor(at(-5).getTime() / 1000)), now)).toEqual(at(-5));
    expect(providerTime(at(-5).toISOString(), now)).toEqual(at(-5));
    for (const bad of [null, undefined, 0, '', 'soon', at(2).getTime()]) expect(providerTime(bad, now)).toBeNull();
  });

  it('a listings read is dated by the provider refresh, so the same cached read fetched twice is the same observation', () => {
    const rows = [{ active: true, price: 140, quantity: 6 }];
    const a = pointsFromListings(rows, [5], at(0), at(-5));
    const b = pointsFromListings(rows, [5], at(4), at(-5));
    expect(a[0]!.observedAt).toEqual(at(-5));
    expect(b[0]!.observedAt).toEqual(a[0]!.observedAt);
    expect([a[0]!.retrievedAt, b[0]!.retrievedAt]).toEqual([at(0), at(4)]);
  });

  const ctx = (hours: number[], prices: number[], extra: Parameters<typeof computeMarketContext>[0]['points'] = []) =>
    computeMarketContext({ basis: 'pair', zone: null, points: [...hours.map((h, i) => ({ observedAt: at(h), priceCents: prices[i]!, activeListings: 300 })), ...extra], now, eventStartAt: at(240) });

  it('up over three days and down over the day is mixed, not flat and not a fall; so is a day that undoes a held three days', () => {
    const c = ctx([-72, -48, -24, -12, 0], [10000, 12500, 15000, 13500, 12000]);
    expect(c).toMatchObject({ adequacy: 'sufficient', direction: 'mixed', observations: { rule: 'h72_up_h24_down' } });
    expect(marketDecision(c)).toEqual({ decision: 'buy', reasons: ['direction_mixed', 'supply_stable', 'prices_mixed'] });
    expect(ctx([-72, -48, -24, -12, 0], [12000, 13500, 15000, 13500, 12000])).toMatchObject({ direction: 'mixed', observations: { rule: 'h72_held_h24_down' } });
    // Both windows agree: a direction. A three-day fall that held over the last day is still a fall.
    expect(ctx([-72, -48, -24, -12, 0], [15000, 14000, 13000, 12500, 12000]).direction).toBe('down');
    expect(ctx([-72, -48, -24, -12, 0], [15000, 13000, 12100, 12000, 12000]).direction).toBe('down');
  });

  it('a held price observed again by the provider is a real point: unchanged prices make a flat series, not a thin one', () => {
    const c = ctx([-72, -60, -48, -36, -24, -12, 0], Array(7).fill(9000));
    expect(c).toMatchObject({ adequacy: 'sufficient', direction: 'flat', points: 7 });
  });

  it('reads without a provider time never make history or freshness, and are counted in the trace', () => {
    const undated = [-11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0].map((h) => ({ observedAt: at(h), priceCents: 9000, activeListings: 3, timeKnown: false, providerAsOf: null, retrievedAt: at(h) }));
    const only = ctx([], [], undated);
    expect(only).toMatchObject({ adequacy: 'insufficient', direction: 'insufficient', points: 0, reasons: ['provider_time_unknown'], current: { priceCents: 9000, timeKnown: false }, observations: { untimed: 12 } });
    // Dated points that are stale stay stale, however many undated reads came after.
    const mixed = ctx([-60, -50, -40, -30], [10000, 9800, 9600, 9400], undated);
    expect(mixed.reasons).toContain('stale:30h');
    expect(mixed).toMatchObject({ points: 4, current: { priceCents: 9400, timeKnown: true }, observations: { untimed: 12 } });
  });
});

describe('TREND-ACC: the decision never waits on mixed or broader-scope movement', () => {
  const base = { now: new Date('2026-10-03T12:00:00Z'), eventStartAt: new Date('2026-10-20T23:00:00Z'), offers: { bestEligibleTotalCents: null, bestEligibleObservationId: null, eligibleCount: 0, needsReviewCount: 0, alternativeAvailable: false, deliveryFeasible: null, safeDeliveryBufferMinutes: null }, benchmark: null, trend: null, priorities: { mustAttend: false, waitRiskTolerance: 'high' as const, decisionDeadline: new Date('2026-10-15T12:00:00Z'), budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false }, monitoringCoverageAvailable: false, staffedUntil: null };
  it('a fall for their seats can wait; mixed, or a venue-wide fall for a floor request, cannot', () => {
    expect(decide({ ...base, market: { basisMatchesGroup: true, direction: 'down', supply: 'stable' } }).decision).toBe('wait_and_recheck');
    const mixed = decide({ ...base, market: { basisMatchesGroup: true, direction: 'mixed', supply: 'stable' } });
    expect(mixed.decision).not.toBe('wait_and_recheck');
    expect(mixed.reasonCodes).toContain('market_mixed_no_clear_direction');
    const broader = decide({ ...base, market: { basisMatchesGroup: false, direction: 'down', supply: 'stable', broaderScope: true } });
    expect(broader.decision).not.toBe('wait_and_recheck');
    expect(broader.reasonCodes).toContain('market_scope_broader_than_request');
  });
});
