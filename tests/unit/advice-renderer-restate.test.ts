import { describe, expect, it } from 'vitest';
import { restates } from '@/lib/advice/renderer';

describe('prose that repeats the claim it cites', () => {
  it('is recognised and dropped', () => {
    const claim = 'I can’t see live resale listings for this show yet, so this doesn’t compare other sellers’ prices.';
    expect(restates('I can’t see live resale listings for this show yet, so I’m not comparing this against other sellers’ current prices.', claim)).toBe(true);
  });
  it('a short lead-in or a different point is kept', () => {
    expect(restates('Where to buy:', 'Still on general sale on Ticketmaster.')).toBe(false);
    expect(restates('For five of you together, the seats matter more than the last few dollars.', 'I can’t see live resale listings for this show yet.')).toBe(false);
  });
});
