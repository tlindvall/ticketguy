import { describe, expect, it } from 'vitest';
import { basisForQuantity, computeMarketContext, pointsFromListings, pointsFromSnapshot, typicalAtLead, marketBasketKey } from '@/lib/market/series';
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
    expect(pts).toEqual([
      { basis: 'single', zone: null, observedAt: new Date('2026-09-22T14:30:00Z'), priceCents: 8900, medianCents: 19800, activeListings: 312 },
      { basis: 'pair', zone: null, observedAt: new Date('2026-09-22T14:30:00Z'), priceCents: 14500, medianCents: 19800, activeListings: 312 },
      { basis: 'single', zone: 'Lower Bowl', observedAt: new Date('2026-09-22T14:30:00Z'), priceCents: 15000, medianCents: 28000, activeListings: null },
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
    expect(pts.every((p) => p.observedAt === at && p.zone === null)).toBe(true);
    // Nothing big enough: no point, rather than a made-up price.
    expect(pointsFromListings(listings, [10], at)).toEqual([]);
  });
});
