import { describe, expect, it } from 'vitest';
import { buildPacket, type BuildPacketArgs, type SubjectListing } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { findAlternatives, listingDrawback, type MarketListing } from '@/lib/market/alternatives';
import type { MarketContext } from '@/lib/market/series';
import type { Evaluated } from '@/lib/domain/comparison';
import type { Offer } from '@/lib/domain/types';

/**
 * Oct 10 2026, the owner's framework for a listing they send ("is this a good deal?", a link, a screenshot or a paste):
 * what I'd do, why in a line, one useful next action. Budget fit, value and timing are separate judgments, and "best
 * deal" is value for this person, not the lowest number. PR #127 did this for price leads; these are the subject cases:
 * a cheaper equivalent (B6a), theirs winning (B6b), a total that can't be read (B6c), a cheaper listing the feed itself
 * faults (B7), and no trend essay under a plain "good deal?" (B8).
 */
const NOW = new Date('2026-10-10T15:00:00Z');
const GAME = new Date('2026-10-30T23:30:00Z');
const L = (priceDollars: number, quantity: number, section: string, row: string, over: Partial<MarketListing> = {}): MarketListing => ({ priceCents: priceDollars * 100, quantity, section, row, zone: 'Lower Bowl', marketplace: null, id: null, url: null, notes: null, ...over });
const ctx = (over: Partial<MarketContext> = {}): MarketContext => ({
  methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 13000, at: new Date(NOW.getTime() - 30 * 60_000), activeListings: 12 },
  h24: { hours: 24, fromCents: 14000, toCents: 13000, changeCents: -1000, pct: -1000 / 14000 }, h72: { hours: 72, fromCents: 15000, toCents: 13000, changeCents: -2000, pct: -2000 / 15000 },
  direction: 'down', supply: { trend: 'stable', now: 12, before: 12, hours: 24 }, typical: null, points: 30, ...over,
});
const listing = (over: Partial<SubjectListing> = {}): SubjectListing => ({
  source: 'screenshot', observedAt: NOW, confidence: 'high', seller: 'StubHub',
  eventName: 'Metro Testers vs. Boston', eventDate: '2026-10-30', venue: null, city: null, quantity: 2,
  priceText: '$180 each + fees', perTicketCents: 18000, wholePartyCents: 36000, priceBasis: 'per_ticket', feeBasis: 'before_fees',
  section: '112', row: '5', seatNumbers: ['7', '8'], seatsTogether: true, restrictions: [], restrictionCodes: [],
  deliveryText: 'Mobile transfer', deliveryBy: '2026-10-29', includedBenefits: [], unreadable: [], ...over,
}) as SubjectListing;
const args = (sub: SubjectListing, market: MarketListing[], over: Partial<BuildPacketArgs> = {}): BuildPacketArgs => {
  const quote = sub.perTicketCents != null ? { perTicketCents: sub.perTicketCents, assumedPerTicket: false, source: sub.source, feeBasis: sub.feeBasis, seenAt: sub.observedAt, seller: sub.seller } : null;
  return {
    requestId: 'r', revision: 1, quantity: 2, eventLabel: 'Metro Testers vs. Boston at Test Garden', eventParts: { title: 'Metro Testers vs. Boston', where: 'Test Garden, New York', when: 'Fri, Oct 30, 7:30 PM EDT' }, eventStartAt: GAME, headerStartAt: GAME, timeZone: 'America/New_York', eventLocalDate: '2026-10-30', eventNoun: 'game', eventCategory: 'nhl',
    best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
    sourcesChecked: ['seatdata'], sourcesUnavailable: [], independentOptionCount: 0, observedAt: NOW, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    market: { basis: 'pair', context: ctx(), supply: ctx().supply, supplyScope: 'group', visible: true },
    subject: sub, quote,
    marketAround: sub.perTicketCents != null ? findAlternatives(market, { perTicketCents: sub.perTicketCents, feeBasis: sub.feeBasis, section: sub.section, row: sub.row }, 2) : null,
    asks: { deliveryRisk: false, accessibleSpaces: false, worth: true },
    ...over,
  } as unknown as BuildPacketArgs;
};
const email = (a: BuildPacketArgs, claimIds: string[] = []) => {
  const p = buildPacket(a);
  const r = validateAndRender(p, { decision: p.decision, opening: 'Here is my take.', paragraphs: [{ claimIds, prose: '' }], closing: 'Let me know.' });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { ...r, packet: p };
};
const verdict = (a: BuildPacketArgs) => buildPacket(a).claimRecords.find((c) => c.id === 'C_VERDICT')!;
const visible = (a: BuildPacketArgs) => buildPacket(a).claimRecords.filter((c) => c.customerVisible).map((c) => c.id);
// A verified offer, its all-in total checked: what research hands the packet as `best`.
const verified = (totalCents: number, over: Partial<Offer> = {}): Evaluated => ({
  offer: { id: 'o1', sourceId: 'ticketmaster', providerListingId: null, eventId: 'e', observedAt: NOW.toISOString(), providerUpdatedAt: null, expiresAt: null, quantity: 2, currency: 'USD', baseTotalCents: totalCents - 4000, mandatoryFeeTotalCents: 4000, taxTotalCents: 0, deliveryTotalCents: 0, payableTotalCents: totalCents, priceCompleteness: 'verified_total', section: '118', row: '9', seatNumbers: null, seatsTogether: true, admissionType: 'reserved', restrictions: [], deliveryMethod: 'mobile', expectedDeliveryAt: null, directPurchaseUrl: 'https://www.ticketmaster.com/event/x', evidenceId: 'ev1', collectionMode: 'approved_api', availability: 'available', ...over },
  verdict: 'eligible', exclusions: [], flags: [], comparableTotalCents: totalCents,
});

describe('a listing they sent: what I’d do, why, one next action', () => {
  it('B6a: a cheaper equivalent in their section is the one I’d choose, compared on the same fee basis, with the marketplace search named', () => {
    const { textBody: text, packet } = email(args(listing(), [L(155, 2, '112', '2'), L(170, 4, '114', '9'), L(200, 2, '112', '3')]));
    expect(verdict(args(listing(), [L(155, 2, '112', '2')])).text).toBe('I’d choose this alternative. Your pair is $360 before fees; this comparable pair in section 112, row 2 is $310 before fees: $50 less, in the same section.');
    expect(text.indexOf('I’d choose this alternative.')).toBeGreaterThan(text.indexOf('Metro Testers vs. Boston'));
    // Its price is the verdict's, not said again; with no marketplace named, both searches (Oct 10 review).
    expect(text).toContain('The listing data doesn’t say whether it’s on StubHub or Vivid Seats, so look for section 112 on both. It isn’t your seats, and I haven’t checked it’s still for sale or that the seats are together.');
    expect(text).toContain('Search StubHub for section 112: https://www.stubhub.com/search?q=Metro%20Testers%20vs.%20Boston');
    expect(text.match(/\$155|\$310/g)).toHaveLength(1);
    // Verdict, why and next action: no venue floor, no trend read, no "verified alternative" hedge, no model closing.
    expect(text).not.toMatch(/Cheaper listings for|Before you buy it|resale market when I last checked|My read:|verified alternative|Let me know|Here is my take/);
    expect(text.match(/Metro Testers vs\. Boston/g)).toHaveLength(1);
    expect(packet.followUps).toEqual([]);
  });

  it('B6a: the listing’s own page is the link when the feed carries one, and an all-in price is compared conservatively', () => {
    const sub = listing({ priceText: '$210 each incl. fees', perTicketCents: 21000, wholePartyCents: 42000, feeBasis: 'all_in' });
    const { textBody: text } = email(args(sub, [L(155, 2, '112', '2', { marketplace: 'stubhub', url: 'https://www.stubhub.com/event/555/?quantity=2&listingId=9' })]));
    expect(text).toContain('I’d choose this alternative. Your pair is $420 with fees; this comparable pair in section 112, row 2 is $310 before fees, in the same section: cheaper than yours only if its fees come to less than $110 in total.');
    expect(text).toContain('That’s a StubHub listing. It isn’t your seats');
    expect(text).toContain('View section 112 on StubHub: https://www.stubhub.com/event/555/?quantity=2&listingId=9');
    expect(text).not.toContain('Search StubHub');
  });

  it('B6a: a before-fees listing within a fee margin of their all-in price is noise, not an alternative', () => {
    const sub = listing({ priceText: '$210 each incl. fees', perTicketCents: 21000, wholePartyCents: 42000, feeBasis: 'all_in' });
    const v = verdict(args(sub, [L(200, 2, '112', '2')]));
    expect(v.values.code).toBe('stick_with_yours');
  });

  it('B6b: nothing like for like is cheaper: stick with yours, said as listed data, with the catches as the only next step', () => {
    const { textBody: text, packet } = email(args(listing(), [L(185, 2, '112', '2'), L(190, 4, '114', '9')]));
    expect(text).toContain('I’d stick with yours. It’s the lowest listed total I found for two together in section 112 or the rest of the Lower Bowl, from 2 listings with two or more tickets.');
    expect(text).not.toMatch(/confirmed total|none in your section or area is clearly cheaper|verified alternative|resale market when I last checked|My read:|Those figures/);
    expect(text).toContain('Worth checking before you buy:');
    expect(packet.claimRecords.find((c) => c.id === 'C_ALTERNATIVES')).toBeUndefined();
  });

  it('B6b: an all-in price against before-fees listings says why a lower listing isn’t cheaper', () => {
    const sub = listing({ priceText: '$210 each incl. fees', perTicketCents: 21000, wholePartyCents: 42000, feeBasis: 'all_in' });
    // The gap said as read, and what would make the lower listing cheaper: never "the lowest listed total" (Oct 10 review).
    expect(verdict(args(sub, [L(205, 2, '112', '2')])).text).toBe('I’d stick with yours. Yours includes fees; the lowest listing for two or more in section 112 or the rest of the Lower Bowl is $5 a ticket under it before fees, so it only comes out cheaper if its fees are less than $5 a ticket.');
  });

  it('B6b: with no listing in their section and no zone for it, nothing like for like was compared, so theirs is not called the lowest', () => {
    const v = verdict(args(listing(), [L(185, 2, '305', '2', { zone: 'Upper' })]));
    expect(v.values.code).toBe('price_above');
    expect(v.text).not.toContain('stick with yours');
  });

  it('B6c: a cut-off total gets the one question, and nothing else', () => {
    const sub = listing({ priceText: null, perTicketCents: null, wholePartyCents: null, priceBasis: 'unknown', feeBasis: 'unknown', unreadable: ['the total is cropped'] });
    const { textBody: text, packet } = email(args(sub, [L(155, 2, '112', '2')]));
    expect(text).toBe('Hey,\n\nMetro Testers vs. Boston\nTest Garden, New York · Friday, October 30, at 7:30 p.m. · 2 tickets\n\nI can see the section and row, but the total is cut off. Send the final price for both, including fees, and I’ll compare it.');
    expect(packet.followUps).toEqual([]);
    expect(packet.claimRecords.filter((c) => c.customerVisible).map((c) => c.id)).toEqual(['C_VERDICT']);
    // A paste without the price, and a screenshot with no section read, each say what was and wasn't read.
    expect(verdict(args(listing({ ...sub, source: 'listing_text', row: null }), [])).text).toBe('I can see the section, but the total isn’t there. Send the final price for both, including fees, and I’ll compare it.');
    expect(verdict(args(listing({ ...sub, section: null, row: null }), [])).text).toBe('I can’t read the price in the screenshot. Send the final price for both, including fees, and I’ll compare it.');
  });

  it('B6c: the wrong game still comes first, cut-off total or not', () => {
    const sub = listing({ priceText: null, perTicketCents: null, wholePartyCents: null, feeBasis: 'unknown', eventDate: '2026-11-02' });
    expect(verdict(args(sub, [])).text).toContain('I wouldn’t buy this one as it stands: the date on it (Nov 2) isn’t the event you asked about (Oct 30).');
  });

  it('B7: a cheaper listing the feed notes as limited view is passed over for theirs, with the saving said', () => {
    const { textBody: text, packet } = email(args(listing(), [L(155, 2, '112', '2', { notes: 'Limited view' })]));
    expect(text).toContain('I’d keep your original pair. The alternative in section 112, row 2 saves $50, but the listing notes a limited or obstructed view. For the small saving, your seats are the better choice.');
    expect(packet.claimRecords.find((c) => c.id === 'C_ALTERNATIVES')).toBeUndefined();
    expect(text).not.toMatch(/Search StubHub|choose this alternative|resale market when I last checked/);
    // The drawback is the feed's own note, never guessed from the price.
    expect(listingDrawback(L(155, 2, '112', '2', { notes: 'Seats may not be together' }))).toBe('seats_not_together');
    expect(listingDrawback(L(50, 2, '112', '2'))).toBeNull();
  });

  it('B7: a clean listing in the same section wins over a cheaper faulted one, and a drawback theirs shares is no worse', () => {
    const market = [L(140, 2, '112', '2', { notes: 'Obstructed view' }), L(160, 2, '112', '9')];
    expect(verdict(args(listing(), market)).text).toBe('I’d choose this alternative. Your pair is $360 before fees; this comparable pair in section 112, row 9 is $320 before fees: $40 less, in the same section.');
    const theirsToo = listing({ restrictions: ['Limited view'], restrictionCodes: ['obstructed_view'] });
    expect(verdict(args(theirsToo, [L(140, 2, '112', '2', { notes: 'Obstructed view' })])).text).toContain('I’d choose this alternative. Your pair is $360 before fees; this comparable pair in section 112, row 2 is $280 before fees');
  });

  it('B7: a larger saving is still passed over, said as that', () => {
    expect(verdict(args(listing(), [L(80, 2, '112', '2', { notes: 'Limited view' })])).text).toContain('saves $200, but the listing notes a limited or obstructed view. Even for that saving, your seats are the better choice.');
  });

  it('B7: a cheaper verified offer the comparison rejected, with its total known, is weighed the same way', () => {
    const sub = listing({ priceText: '$210 each incl. fees', perTicketCents: 21000, wholePartyCents: 42000, feeBasis: 'all_in' });
    const { textBody: text } = email(args(sub, [], { leftOut: [{ reason: 'obstructed_view', quantity: 2, totalCents: 38500 }] }));
    // Named, so "the alternative" has something to refer to (Oct 10 review).
    expect(text).toContain('I’d keep your original pair. The verified pair I found is $35 less with fees, but it has a limited or obstructed view. For the small saving, your seats are the better choice.');
    expect(text).not.toContain('I left out a cheaper listing');
    // Without its total, nothing is said as cheaper than theirs.
    expect(verdict(args(sub, [], { leftOut: [{ reason: 'obstructed_view', quantity: 2 }] })).values.code).not.toBe('keep_yours');
  });

  it('B8: a plain "is this a good deal?" with a readable total gets no buy-or-wait essay; asked about timing, it does', () => {
    const quiet = email(args(listing(), [L(185, 2, '112', '2')]));
    expect(quiet.textBody).not.toMatch(/My read:|easing|hold off|wait/i);
    // Asked about timing, the series answers it, and the market section it reads from is shown with it.
    const asked = email(args(listing(), [L(185, 2, '112', '2')], { trendAsked: { noAlerts: false, riskOk: false } }), ['C_MARKET']);
    expect(asked.packet.claimRecords.find((c) => c.id === 'C_TREND_ANSWER')?.customerVisible).toBe(true);
    expect(asked.textBody).toContain('I’d stick with yours.');
    expect(asked.textBody).toContain('The resale market when I last checked:');
  });

  // Oct 10 review of PR #128: each case renders the real email text and pins what it said wrong.
  it('the chosen alternative’s price is said once, in the verdict, not again under it', () => {
    const one = listing({ quantity: 1, priceText: '$180 + fees', perTicketCents: 18000, wholePartyCents: 18000, seatNumbers: ['7'] });
    const market = [L(155, 1, '112', '2'), L(200, 2, '112', '3')];
    const { textBody: text } = email(args(one, market, { quantity: 1, marketAround: findAlternatives(market, { perTicketCents: 18000, feeBasis: 'before_fees', section: '112', row: '5' }, 1) }));
    expect(text).toContain('I’d choose this alternative. Your ticket is $180 before fees; this comparable ticket in section 112, row 2 is $155 before fees: $25 less, in the same section.');
    expect(text.match(/\$155/g)).toHaveLength(1);
  });

  it('a listing with no marketplace named sends them to both searches, never to StubHub alone', () => {
    const { textBody: text } = email(args(listing(), [L(155, 2, '112', '2')]));
    expect(text).toContain('The listing data doesn’t say whether it’s on StubHub or Vivid Seats, so look for section 112 on both.');
    expect(text).toContain('Search StubHub for section 112: https://www.stubhub.com/search?q=Metro%20Testers%20vs.%20Boston');
    expect(text).toContain('Search Vivid Seats for section 112: https://www.vividseats.com/search?searchTerm=Metro%20Testers%20vs.%20Boston');
    // Named by the feed, its own marketplace only.
    const vivid = email(args(listing(), [L(155, 2, '112', '2', { marketplace: 'vividseats' })])).textBody;
    expect(vivid).toContain('That’s a Vivid Seats listing. It isn’t your seats');
    expect(vivid).toContain('Search Vivid Seats for section 112: https://www.vividseats.com/search?searchTerm=');
    expect(vivid).not.toContain('stubhub.com');
  });

  it('kept over a faulted listing, an all-in price is never said to make a before-fees gap a saving', () => {
    const sub = listing({ priceText: '$210 each incl. fees', perTicketCents: 21000, wholePartyCents: 42000, feeBasis: 'all_in' });
    const v = verdict(args(sub, [L(155, 2, '112', '2', { notes: 'Limited view' })]));
    expect(v.values.code).toBe('keep_yours');
    expect(v.text).toBe('I’d keep your original pair. The alternative in section 112, row 2 is listed $110 under yours before its fees, but the listing notes a limited or obstructed view, so your seats are the better choice.');
    expect(v.text).not.toMatch(/saving|saves/);
    // A price that may or may not include fees is compared as listed, and the checkout totals decide.
    const unsure = listing({ priceText: '$180 each', feeBasis: 'unknown' });
    expect(verdict(args(unsure, [L(155, 2, '112', '2')])).text).toBe('I’d choose this alternative. Your pair is $360, and I can’t tell whether that includes fees; this comparable pair in section 112, row 2 is $310 before fees, in the same section: $50 less as listed, so compare the checkout totals.');
  });

  it('"stick with yours" counts only the listings compared like for like, and an all-in price is not called the lowest total', () => {
    // Two cheaper pairs in another zone: nothing in their section or zone was compared, so no "lowest" and no count.
    const v = verdict(args(listing(), [L(185, 1, '112', '2'), L(100, 2, '305', '1', { zone: 'Upper' }), L(110, 2, '306', '1', { zone: 'Upper' })]));
    expect(v.values.code).not.toBe('stick_with_yours');
    expect(v.text).not.toMatch(/lowest listed/);
    // Sixty listings upstairs and one in their section: the one is the count.
    const upstairs = Array.from({ length: 60 }, (_, i) => L(400 + i, 2, `3${i}`, '1', { zone: 'Upper' }));
    expect(verdict(args(listing(), [L(185, 2, '112', '2'), ...upstairs])).text).toBe('I’d stick with yours. It’s the lowest listed total I found for two together in section 112 or the rest of the Lower Bowl, from 1 listing with two or more tickets.');
    // All-in against a lower before-fees listing: the gap said as read, and what would make it cheaper.
    const sub = listing({ priceText: '$210 each incl. fees', perTicketCents: 21000, wholePartyCents: 42000, feeBasis: 'all_in' });
    expect(verdict(args(sub, [L(205, 2, '112', '2')])).text).toBe('I’d stick with yours. Yours includes fees; the lowest listing for two or more in section 112 or the rest of the Lower Bowl is $5 a ticket under it before fees, so it only comes out cheaper if its fees are less than $5 a ticket.');
  });

  it('a GA listing with nothing cheaper in the venue says so; one with cheaper listings elsewhere is not called the lowest', () => {
    const ga = listing({ section: null, row: null, seatNumbers: null, priceText: '$135 each incl. fees', perTicketCents: 13500, wholePartyCents: 27000, feeBasis: 'all_in' });
    const none = email(args(ga, [L(140, 2, 'GA', null as unknown as string, { zone: 'Floor' }), L(150, 4, 'GA', null as unknown as string, { zone: 'Floor' }), L(160, 2, '101', '4', { zone: 'Lower' })]));
    expect(none.textBody).toContain('I’d stick with yours. It’s the lowest listed total I found for two together anywhere in the venue, from 3 listings with two or more tickets.');
    expect(verdict(args(ga, [L(60, 2, '101', '4', { zone: 'Lower' })])).values.code).not.toBe('stick_with_yours');
  });

  it('below the venue floor, the check is said once: the fees are left to the catches', () => {
    const cheap = listing({ priceText: '$120 each + fees', perTicketCents: 12000, wholePartyCents: 24000 });
    const { textBody: text } = email(args(cheap, [L(125, 2, '112', '2')]));
    expect(text).toContain('It’s also below the cheapest listing I can see anywhere in the venue ($130 a ticket before fees), which is unusual, so check the seats and the number of tickets before you pay.');
    expect(text.match(/fees/gi)!.length).toBeLessThanOrEqual(3);
    expect(text).toContain('Fees are extra, so the total at checkout will be higher than the listed price.');
  });

  it('asked about timing, the venue floor is not compared again under a verdict that already compared like for like', () => {
    const asked = email(args(listing(), [L(185, 2, '112', '2')], { trendAsked: { noAlerts: false, riskOk: false } }), ['C_MARKET']);
    expect(asked.textBody).toContain('I’d stick with yours.');
    expect(asked.textBody).not.toContain('Against resale');
    expect(asked.packet.claimRecords.find((c) => c.id === 'C_QUOTE_MARKET')?.customerVisible ?? false).toBe(false);
    // The move is said once, in the buy-or-wait answer; the market section keeps the floor it reads from.
    expect(asked.textBody).toContain('have fallen from $150 to $130 a ticket over the last three days');
    expect(asked.textBody.match(/\$150/g)).toHaveLength(1);
    expect(asked.textBody.match(/\$130/g)!.length).toBeLessThanOrEqual(2);
  });

  it('the alternative under the verdict is the one the verdict chose: nothing about a market listing under a verified option', () => {
    const sub = listing({ priceText: '$180 each incl. fees', perTicketCents: 18000, wholePartyCents: 36000, feeBasis: 'all_in' });
    const { textBody: text, packet } = email(args(sub, [L(100, 2, '112', '2')], { best: verified(30000) }), ['C_BEST']);
    expect(String(packet.claimRecords.find((c) => c.id === 'C_VERDICT')!.values.code)).toBe('verified_cheaper');
    expect(packet.claimRecords.find((c) => c.id === 'C_ALTERNATIVES')).toBeUndefined();
    expect(text).not.toMatch(/That’s a StubHub|Search StubHub|isn’t your seats/);
  });

  it('B7 from research: the rejected verified offer is named, priced on the same all-in basis, and left out of the left-out line', () => {
    const sub = listing({ priceText: '$210 each incl. fees', perTicketCents: 21000, wholePartyCents: 42000, feeBasis: 'all_in' });
    const leftOut = [{ reason: 'obstructed_view' as const, quantity: 2, totalCents: 38500, section: '118', row: '22' }, { reason: 'accessible_only' as const, quantity: 2 }];
    const { textBody: text } = email(args(sub, [], { leftOut }));
    expect(text).toContain('I’d keep your original pair. The verified pair I found in section 118, row 22 is $35 less with fees, but it has a limited or obstructed view. For the small saving, your seats are the better choice.');
    expect(text).toContain('I left out a cheaper listing: one is wheelchair or companion spaces, meant for people who need them.');
    expect(text).not.toContain('obstructed view, which you ruled out');
  });

  it('a keep-yours verdict about a market listing leaves an unrelated left-out offer said', () => {
    const { textBody: text } = email(args(listing(), [L(155, 2, '112', '2', { notes: 'Limited view' })], { leftOut: [{ reason: 'accessible_only', quantity: 2 }] }));
    expect(text).toContain('I’d keep your original pair. The alternative in section 112, row 2 saves $50');
    expect(text).toContain('I left out a cheaper listing: one is wheelchair or companion spaces, meant for people who need them.');
  });

  it('a total that can’t be read still shows the verified option research found, with its link', () => {
    const sub = listing({ priceText: null, perTicketCents: null, wholePartyCents: null, priceBasis: 'unknown', feeBasis: 'unknown', unreadable: ['the total is cropped'] });
    const a = args(sub, [], { best: verified(30000) });
    expect(visible(a)).toEqual(expect.arrayContaining(['C_VERDICT', 'C_BEST']));
    const { textBody: text } = email(a, ['C_BEST']);
    expect(text).toContain('I can see the section and row, but the total is cut off. Send the final price for both, including fees, and I’ll compare it.');
    expect(text).toContain('https://www.ticketmaster.com/event/x');
  });
});
