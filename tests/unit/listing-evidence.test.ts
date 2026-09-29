import { describe, expect, it } from 'vitest';
import { fieldsFromRead, looksLikeListingText, restrictionCodesFrom, type ListingRead } from '@/lib/ai/listing-evidence';

describe('listing text and reads', () => {
  it('a request with a row and a budget is not a pasted listing; a found listing is', () => {
    expect(looksLikeListingText('2 tickets, row 1 preferred, budget $300')).toBe(false);
    expect(looksLikeListingText('Found this on StubHub: Sec 112 Row 5, $210 each')).toBe(true);
    expect(looksLikeListingText('Section 101 row 3, $95 ea')).toBe(true);
  });
  it('keeps unknowns unknown and only derives a per-ticket price the page makes certain', () => {
    const base = { kind: 'ticket_listing', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: 4, priceText: '$800', priceDollars: 800, priceBasis: 'whole_party', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: [], seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'high', unreadable: [] } as ListingRead;
    expect(fieldsFromRead(base)).toMatchObject({ perTicketCents: 20000, wholePartyCents: 80000, seatNumbers: null, seatsTogether: null, feeBasis: 'unknown' });
    expect(fieldsFromRead({ ...base, priceBasis: 'unknown', priceDollars: 200 })).toMatchObject({ perTicketCents: 20000, wholePartyCents: null, priceBasis: 'unknown' });
  });
  it('maps the page’s own words onto restriction codes', () => {
    expect(restrictionCodesFrom(['Wheelchair accessible', 'Limited view', '21+'])).toEqual(['accessible_seating', 'obstructed_view']);
  });
});
