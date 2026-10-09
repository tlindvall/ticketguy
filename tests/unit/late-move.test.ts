import { describe, expect, it } from 'vitest';
import { lateMoveFrom } from '@/lib/market/series';
import { TREND_ASKED } from '@/lib/intake/pipeline';

const DAY = 24 * 60;
/** One past event: its price at `lead` minutes before the start and at 6 hours before. */
const past = (key: string, lead: number, from: number, to: number) => [
  { eventKey: key, leadMinutes: lead, priceCents: from },
  { eventKey: key, leadMinutes: 6 * 60, priceCents: to },
];

describe('what past events did from this point to their final day', () => {
  it('counts falls, rises and holds by the live trend rule, one per event', () => {
    const rows = [...past('a', 20 * DAY, 10000, 8000), ...past('b', 21 * DAY, 10000, 8000), ...past('c', 19 * DAY, 10000, 12000), ...past('d', 20 * DAY, 10000, 10200), ...past('e', 20 * DAY, 10000, 9000), { eventKey: 'a', leadMinutes: 2 * 60, priceCents: 7000 }];
    // 'a' uses its last point (2 hours out): $100 → $70.
    expect(lateMoveFrom(rows, 20 * DAY)).toEqual({ events: 5, fell: 3, rose: 1, held: 1, medianPct: -0.1, leadBucket: '14-30d' });
  });
  it('says nothing with fewer than five past events, or in the final two days', () => {
    const four = ['a', 'b', 'c', 'd'].flatMap((k) => past(k, 20 * DAY, 10000, 8000));
    expect(lateMoveFrom(four, 20 * DAY)).toBeNull();
    const five = ['a', 'b', 'c', 'd', 'e'].flatMap((k) => past(k, 36 * 60, 10000, 8000));
    expect(lateMoveFrom(five, 36 * 60)).toBeNull();
  });
  it('a point from another lead bucket is not "this point"', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((k) => past(k, 5 * DAY, 10000, 8000));
    expect(lateMoveFrom(rows, 20 * DAY)).toBeNull();
  });
});

describe('a question about a drop is a trend question', () => {
  it.each(['Do you think there could be a drop in the prices nearer the game?', 'Will prices come down closer to the date?', 'Are they getting cheaper?', 'could the price drop before kickoff'])('%s', (q) => {
    expect(TREND_ASKED.test(q)).toBe(true);
  });
});
