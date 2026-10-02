import { describe, expect, it } from 'vitest';
import { buildPacket, listingCatches, type BuildPacketArgs, type SubjectListing } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { questionsAsked, unverifiedRequirements } from '@/lib/intake/pipeline';
import type { MarketContext } from '@/lib/market/series';
import { RequestExtractionSchema } from '@/lib/domain/types';

/**
 * The live email audit of Sep 29 (TGQA-0929), case by case: each test is one of its acceptance criteria, on the
 * packet and the rendered email rather than on wording the model might produce.
 */
const at = new Date('2026-09-30T00:00:00Z');
const ctx = (priceCents: number, over: Partial<MarketContext> = {}): MarketContext => ({ methodVersion: 'm', basis: 'group:5', zone: null, adequacy: 'insufficient', reasons: [], current: { priceCents, at: new Date(at.getTime() - 6 * 3_600_000), activeListings: 238 }, h24: null, h72: null, direction: 'insufficient', supply: { trend: 'unknown', now: 238, before: null, hours: null }, typical: null, points: 1, ...over });
const priorities = (budgetTotalCents: number | null) => ({ mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false });
const args = (over: Partial<BuildPacketArgs>, market: MarketContext | null) => ({
  requestId: 'r', revision: 1, quantity: 5, eventLabel: 'New York Rangers vs. Tampa Bay Lightning at Madison Square Garden, Thu, Oct 1', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
  policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
  priorities: priorities(null), sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
  market: market ? { basis: market.basis, context: market, supply: market.supply, supplyScope: 'group', comparableLabel: null, visible: true } : null, ...over,
}) as unknown as BuildPacketArgs;
const claim = (p: ReturnType<typeof buildPacket>, id: string) => p.claimRecords.find((c) => c.id === id)?.text ?? '';
const render = (p: ReturnType<typeof buildPacket>) => {
  const r = validateAndRender(p, { decision: p.decision, opening: 'Here is what I found.', paragraphs: [{ claimIds: p.claimRecords.filter((c) => c.id === 'C_MARKET').map((c) => c.id), prose: '' }], closing: '' });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.textBody;
};

describe('TG-B03/B04: the budget is checked against the group total; a venue-wide floor is never "fair"', () => {
  it('A01: five under $600 total, floor $121.75 before fees six hours ago: already over, said with its age', () => {
    const p = buildPacket(args({ priorities: priorities(60000) }, ctx(12175)));
    const read = claim(p, 'C_READ');
    // What that price would come to for five, not a sellable five-seat offer; one sample doesn't prove the market.
    // The floor itself, with its age, is in the market lines above; the read doesn't repeat it (PW-EMAIL-FOCUS-01).
    expect(read).toContain('My read: your budget is $600 for five ($120 a ticket); at that price, five come to $608.75 before fees, over it before any fees.');
    expect(read).not.toContain('$121.75');
    expect(read).toContain('That doesn’t prove nothing cheaper exists now, but I haven’t seen anything within it.');
    expect(read).not.toMatch(/fair|better deal|\$140|won’t cover/);
  });
  it('A07: two under $180 total, floor $84.89: under before fees, with fees and seats still to check', () => {
    const p = buildPacket(args({ quantity: 2, priorities: priorities(18000) }, ctx(8489, { basis: 'pair', adequacy: 'sufficient' })));
    const read = claim(p, 'C_READ');
    // $10.22 of room for every remaining charge: never a standalone "under budget" (remediation review §3).
    expect(read).toContain('at that price, two come to $169.78 before fees, which leaves $10.22 of your $180 for fees. I can’t see those fees, so whether it fits is unconfirmed until you see the checkout total.');
    expect(read).not.toContain('$84.89');
    expect(read).not.toMatch(/fair|\$98|under your/);
  });
  it('no budget: the lowest asking price seen, when and where, never a minimum for every seat (R3-B06)', () => {
    const p = buildPacket(args({}, ctx(12175)));
    const read = claim(p, 'C_READ');
    // The floor, when and for which listings, is said once, in the market lines; the read adds no second copy.
    expect(claim(p, 'C_MARKET')).toMatch(/started at \$121\.75 a ticket \(listed price, before fees\)/);
    expect(claim(p, 'C_MARKET')).toMatch(/As of about 6 hours ago/);
    expect(read).not.toContain('$121.75');
    expect(read).not.toMatch(/that or more|will cost/);
    expect(read).not.toMatch(/fair price/);
  });
});

describe('TG-B01: an open sale is not an endorsement when there are needs it cannot vouch for', () => {
  it('A05: 3 together, $450 total, step-free access are each listed as still to check', () => {
    const x = RequestExtractionSchema.parse({ intent: 'new_search', eventName: null, performerOrTeam: 'Hamilton', city: 'New York', state: 'NY', dateExpression: null, resolvedLocalDate: '2026-10-03', quantity: 3, budgetCents: 45000, budgetBasis: 'whole_party', seatingPreference: null, togetherRequired: true, accessibilityNeeds: 'step-free access', alternativesAllowed: null, submittedUrls: [], evidence: [], ambiguities: [] });
    expect(unverifiedRequirements(x)).toEqual(['3 seats together', '$450 in total for all 3, once fees are added', 'Step-free access']);
  });
  it('in the full answer, the official sale is a place to check, not "where I’d buy"', () => {
    const p = buildPacket(args({ quantity: 3, priorities: priorities(45000), accessibilityRequired: true, official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/x' } }, null));
    const off = p.claimRecords.find((c) => c.id === 'C_OFFICIAL')!;
    expect(off.text).not.toMatch(/where I’d buy/);
    expect(off.text).toContain('check the all-in total and the access you need there before you buy');
    expect(off.linkLabel).toBe('Event page on Ticketmaster');
  });
});

describe('TG-B02: their own question is answered first', () => {
  it('A08: delivery at 6pm for a 7pm game with a noon departure is a delivery question, answered first', () => {
    const text = 'Two tickets $220 total for the game at 7pm. Seller says delivery by 6pm but we leave at noon to drive there. If they don’t arrive, is a refund enough?';
    expect(questionsAsked(text)).toEqual({ deliveryRisk: true, accessibleSpaces: false, salesAsked: false, parking: null, gapAgainst: null, worth: false, difference: false });
    const p = buildPacket(args({ quantity: 2, asks: questionsAsked(text) }, ctx(8489, { basis: 'pair', adequacy: 'sufficient' })));
    const body = render(p);
    const opening = body.split('\n\n')[2]!;
    expect(opening).toMatch(/^On delivery:/);
    expect(opening).toContain('a refund guarantee, if the seller offers one, gives the money back; it doesn’t get you into the game');
    expect(body).not.toMatch(/guaranteed|will arrive|will be delivered|you’ll get in/i);
  });
  it('A03: wheelchair spaces beside ordinary seats are not a cheaper version of them', () => {
    const text = 'Two options: wheelchair spaces in 105 for $80 each, or regular seats in 110 for $105 each. Which is better?';
    expect(questionsAsked(text).accessibleSpaces).toBe(true);
    const p = buildPacket(args({ quantity: 2, asks: questionsAsked(text) }, null));
    expect(claim(p, 'C_ACCESS')).toContain('not a cheaper version of ordinary seats');
  });
  it('a passing "transfer" or "accessible" is not a question about them', () => {
    expect(questionsAsked('Two Knicks tickets, mobile transfer is fine')).toEqual({ deliveryRisk: false, accessibleSpaces: false, salesAsked: false, parking: null, gapAgainst: null, worth: false, difference: false });
  });
  // The remediation review's intent cases (§1).
  it('a paraphrase of the delivery question counts', () => {
    expect(questionsAsked('Will these reach my phone before we get on the train at noon?').deliveryRisk).toBe(true);
  });
  it('turning wheelchair spaces down is not a question about them', () => {
    expect(questionsAsked("I don't need wheelchair spaces; compare these two ordinary offers").accessibleSpaces).toBe(false);
  });
  it('A03 exact wording: an accessible offer on the table, which neither of them needs', () => {
    expect(questionsAsked("We're two adults and neither of us needs wheelchair-accessible seating. Offer A says wheelchair-accessible spaces, $80 each including fees. Offer B is ordinary seats together, section 211 row 12, $105 each including fees.").accessibleSpaces).toBe(true);
  });
  it('A08-R1 exact wording is still the delivery question', () => {
    expect(questionsAsked('My question is about delivery risk, not whether prices will fall. Delivery is promised by 6pm on October 1, the game is at 7pm, and we leave home at noon for a three-hour trip with a child. A refund could still mean missing the game, right? Please address that.').deliveryRisk).toBe(true);
  });
});

describe('TG-B08: what they left out is about their message, not the seller', () => {
  it('a pasted summary without seat numbers says they haven’t included them, not that the seller hides them', () => {
    const sub = { source: 'listing_text', section: '110', seatNumbers: null, seatsTogether: null, feeBasis: 'unknown', deliveryBy: null, deliveryText: null, quantity: 2, restrictionCodes: [], restrictions: [], includedBenefits: [], unreadable: [], confidence: 'high', eventDate: null, wholePartyCents: 21000 } as unknown as SubjectListing;
    const items = listingCatches(args({ quantity: 2 }, null), sub).join('\n');
    expect(items).toContain('You haven’t included seat numbers. Check the listing if you want to know exactly where you’ll sit.');
    expect(items).not.toMatch(/It doesn’t (show|say)|until after you buy/);
  });
});

describe('TG-B10: a watch request gets its real status', () => {
  it('nothing running: says so first, plainly', () => {
    const p = buildPacket(args({ quantity: 2, watchStatus: { running: false } }, null));
    expect(render(p).split('\n\n')[2]).toBe('I can’t watch prices for you yet, so nothing is being monitored for this request and no alert will come. Reply any time and I’ll check again.');
  });
  it('running: the terms from the stored watch, with how to stop it', () => {
    const p = buildPacket(args({ quantity: 2, timeZone: 'America/New_York', watchStatus: { running: true, quantity: 2, targetTotalCents: 18000, togetherRequired: true, expiresAt: new Date('2026-09-30T22:00:00Z') } }, null));
    expect(claim(p, 'C_WATCH')).toBe('I’m watching this for you: 2 tickets together, and I’ll email you if I find them for $180 or less in total, including fees. The watch ends Sep 30, 6:00 PM EDT. Reply “stop” any time to end it.');
  });
});

describe('post-#54 R03: their fee basis is kept, and a delivery question gets no buy-or-wait passage', () => {
  const easing = (over: Partial<MarketContext> = {}) => ctx(8489, { basis: 'pair', adequacy: 'sufficient', direction: 'down', ...over });
  it('"$220 total including fees" is compared as all-in, not "can’t tell whether it includes fees" (R3-B02)', () => {
    const p = buildPacket(args({ quantity: 2, quote: { perTicketCents: 11000, assumedPerTicket: false, source: 'customer_reported', feeBasis: 'all_in' } }, easing()));
    const q = claim(p, 'C_QUOTE_MARKET');
    expect(q).toContain('Your price includes fees and that one doesn’t');
    expect(q).not.toContain('I can’t tell whether your price includes fees');
  });
  it('asked about delivery before a noon departure: no "when you need to decide" or waiting advice (R3-B03)', () => {
    const p = buildPacket(args({ quantity: 2, asks: { deliveryRisk: true, accessibleSpaces: false }, travelling: true }, easing()));
    const body = p.claimRecords.map((c) => c.text).join('\n');
    expect(body).toContain('On delivery:');
    expect(body).not.toMatch(/when you need to decide|waiting (can be|would help|is worth)|hold out/);
  });
});
