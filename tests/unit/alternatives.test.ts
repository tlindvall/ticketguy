import { describe, expect, it } from 'vitest';
import { findAlternatives, type MarketListing, matchLinkedListing, toMarketListing } from '@/lib/market/alternatives';

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

  // No guessed fee allowance decides what counts as cheaper (remediation review §4): a listed price below theirs
  // is cheaper as listed, on either basis, and the email says when the bases differ.
  it('cheaper means cheaper as listed, with no percentage band for fees', () => {
    expect(findAlternatives(market, { perTicketCents: 18000, feeBasis: 'all_in', section: '112', row: '5' }, 4).alternatives.length).toBeGreaterThan(0);
    expect(findAlternatives(market, { perTicketCents: 18000, feeBasis: 'before_fees', section: '112', row: '5' }, 4).alternatives.length).toBeGreaterThan(0);
    expect(findAlternatives(market, { perTicketCents: 10000, feeBasis: 'all_in', section: '112', row: '5' }, 4).alternatives).toHaveLength(0);
  });
});

describe('the listing a customer linked, found by its listing number', () => {
  const at = (id: string | null, marketplace: 'stubhub' | 'vividseats' | null, price = 100): MarketListing => ({ priceCents: price * 100, quantity: 4, section: '112', row: '2', zone: 'Lower Bowl', id, marketplace });
  it('reads the id and marketplace from the feed when it has them', () => {
    expect(toMarketListing({ active: true, listing_id: 6189203345, price: 155, quantity: 5, section: '112', row: '2', source: 'sh' })).toMatchObject({ id: '6189203345', marketplace: 'stubhub', priceCents: 15500 });
    expect(toMarketListing({ price: 90, quantity: 2, id: 'ab-123', marketplace: 'Vivid Seats' })).toMatchObject({ id: 'ab-123', marketplace: 'vividseats' });
    expect(toMarketListing({ price: 90, quantity: 2 })).toMatchObject({ id: null, marketplace: null });
  });
  it('matches the same number on the same marketplace', () => {
    expect(matchLinkedListing([at('111', 'vividseats', 80), at('111', 'stubhub', 120)], { marketplace: 'stubhub', listingId: '111' })?.priceCents).toBe(12000);
  });
  it('never matches the same number on another marketplace', () => {
    expect(matchLinkedListing([at('111', 'vividseats')], { marketplace: 'stubhub', listingId: '111' })).toBeNull();
  });
  it('a number with no marketplace counts only when it is the only one', () => {
    expect(matchLinkedListing([at('111', null)], { marketplace: 'stubhub', listingId: '111' })).not.toBeNull();
    expect(matchLinkedListing([at('111', null), at('111', null, 90)], { marketplace: 'stubhub', listingId: '111' })).toBeNull();
  });
  it('no listing number, or a marketplace the feed does not cover, is no match; nothing is guessed from section or price', () => {
    expect(matchLinkedListing([at('111', 'stubhub')], { marketplace: 'stubhub', listingId: null })).toBeNull();
    expect(matchLinkedListing([at('111', null)], { marketplace: 'seatgeek', listingId: '111' })).toBeNull();
    expect(matchLinkedListing([at('112', 'stubhub')], { marketplace: 'stubhub', listingId: '111' })).toBeNull();
  });
});
