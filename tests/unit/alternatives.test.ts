import { describe, expect, it } from 'vitest';
import { findAlternatives, type MarketListing } from '@/lib/market/alternatives';

const L = (priceDollars: number, quantity: number, section: string, row: string, zone: string): MarketListing => ({ priceCents: priceDollars * 100, quantity, section, row, zone });

describe('cheaper listings around the one a customer sent', () => {
  const market = [L(150, 4, '112', '5', 'Lower Bowl'), L(155, 5, '112', '2', 'Lower Bowl'), L(140, 6, '114', '9', 'Lower Bowl'), L(90, 2, '112', '1', 'Lower Bowl'), L(100, 8, '305', '1', 'Upper')];

  it('never offers back a listing in their own section and row, which may be the same seats', () => {
    const r = findAlternatives(market, { perTicketCents: 21000, feeBasis: 'all_in', section: '112', row: '5' }, 4);
    expect(r.alternatives.map((a) => `${a.scope}:${a.listing.section}-${a.listing.row}`)).toEqual(['same_section:112-2', 'same_zone:114-9']);
    expect(r.zone).toBe('Lower Bowl');
  });

  it('only counts listings that can seat the whole party', () => {
    const r = findAlternatives(market, { perTicketCents: 21000, feeBasis: 'all_in', section: '112', row: '5' }, 5);
    expect(r.comparable).toBe(3);
    expect(r.alternatives.every((a) => a.listing.quantity >= 5)).toBe(true);
  });

  it('allows for fees: an all-in price is only beaten by a before-fees price 30% lower', () => {
    expect(findAlternatives(market, { perTicketCents: 18000, feeBasis: 'all_in', section: '112', row: '5' }, 4).alternatives).toHaveLength(0); // 140 * 1.3 > 180
    expect(findAlternatives(market, { perTicketCents: 18000, feeBasis: 'before_fees', section: '112', row: '5' }, 4).alternatives.length).toBeGreaterThan(0);
  });
});
