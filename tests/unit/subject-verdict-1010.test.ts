import { describe, expect, it } from 'vitest';
import { buildPacket, type BuildPacketArgs, type SubjectListing } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { findAlternatives, listingDrawback, type MarketListing } from '@/lib/market/alternatives';
import type { MarketContext } from '@/lib/market/series';

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

describe('a listing they sent: what I’d do, why, one next action', () => {
  it('B6a: a cheaper equivalent in their section is the one I’d choose, compared on the same fee basis, with the marketplace search named', () => {
    const { textBody: text, packet } = email(args(listing(), [L(155, 2, '112', '2'), L(170, 4, '114', '9'), L(200, 2, '112', '3')]));
    expect(verdict(args(listing(), [L(155, 2, '112', '2')])).text).toBe('I’d choose this alternative. Your pair is $360 before fees; this comparable pair in section 112, row 2 is $310 before fees: $50 less, in the same section.');
    expect(text.indexOf('I’d choose this alternative.')).toBeGreaterThan(text.indexOf('Metro Testers vs. Boston'));
    expect(text).toContain('That’s a StubHub or Vivid Seats listing at $155 a ticket before fees. It isn’t your seats, and I haven’t checked it’s still for sale or that the seats are together.');
    expect(text).toContain('Search StubHub for section 112: https://www.stubhub.com/search?q=Metro%20Testers%20vs.%20Boston');
    // Verdict, why and next action: no venue floor, no trend read, no "verified alternative" hedge, no model closing.
    expect(text).not.toMatch(/Cheaper listings for|Before you buy it|resale market when I last checked|My read:|verified alternative|Let me know|Here is my take/);
    expect(text.match(/Metro Testers vs\. Boston/g)).toHaveLength(1);
    expect(packet.followUps).toEqual([]);
  });

  it('B6a: the listing’s own page is the link when the feed carries one, and an all-in price is compared conservatively', () => {
    const sub = listing({ priceText: '$210 each incl. fees', perTicketCents: 21000, wholePartyCents: 42000, feeBasis: 'all_in' });
    const { textBody: text } = email(args(sub, [L(155, 2, '112', '2', { marketplace: 'stubhub', url: 'https://www.stubhub.com/event/555/?quantity=2&listingId=9' })]));
    expect(text).toContain('I’d choose this alternative. Your pair is $420 with fees; this comparable pair in section 112, row 2 is $310 before fees, in the same section: cheaper than yours only if its fees come to less than $110 in total.');
    expect(text).toContain('That’s a StubHub listing at $155 a ticket before fees.');
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
    expect(verdict(args(sub, [L(205, 2, '112', '2')])).text).toBe('I’d stick with yours. It’s the lowest listed total I found for two together in section 112 or the rest of the Lower Bowl, from 1 listing with two or more tickets. Your price includes fees and those are listed before them, so only a listing well under yours would beat it, and none there is.');
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
    expect(text).toContain('I’d keep your original pair. The alternative saves $35, but it has a limited or obstructed view. For the small saving, your seats are the better choice.');
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
});
