import { describe, expect, it } from 'vitest';
import { decide, type PolicyInput } from '@/lib/advice/policy';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { evaluateOffer } from '@/lib/domain/comparison';
import type { Offer } from '@/lib/domain/types';
import { briefCard, type TicketBrief } from '@/lib/email/ticket-brief';
import { categoryLabel, eventNounFor, isLiveMusic } from '@/lib/domain/event-noun';
import { fixtureOffer, FIXTURE_EVENT_ID } from '../fixtures/offers';

/**
 * The ticket brief (design package, Oct 6): a checked offer gets the lime "checkout checked" card with the seller's own
 * listing as the one button, only when every fact on it was checked; anything less keeps the plain claim. The price
 * lead's wording is pinned in market-tracking and take-charge-1003, where it comes from the real research path.
 */
const NOW = new Date('2026-11-12T15:00:00Z');
const START = new Date('2026-11-20T01:00:00Z');
const priorities = { mustAttend: true, waitRiskTolerance: 'low' as const, decisionDeadline: null, budgetTotalCents: 250000, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false };
const policyInput: PolicyInput = { now: NOW, eventStartAt: START, offers: { bestEligibleTotalCents: 218400, bestEligibleObservationId: 'o1', eligibleCount: 1, needsReviewCount: 0, alternativeAvailable: false, deliveryFeasible: true, safeDeliveryBufferMinutes: 120 }, benchmark: null, trend: null, priorities, monitoringCoverageAvailable: false, staffedUntil: null };
const constraints = { quantity: 2, togetherRequired: true, budgetTotalCents: 250000, excludeObstructedView: true, requireAccessible: false, acceptableSections: null, eventStartAt: START.toISOString() };

function checked(over: Partial<Offer> = {}): Offer {
  return fixtureOffer({ sourceId: 'stubhub', providerListingId: 'L-8812', observedAt: new Date(NOW.getTime() - 3 * 60_000).toISOString(), quantity: 2, baseTotalCents: 180000, mandatoryFeeTotalCents: 38400, payableTotalCents: 218400, section: '111', row: 'L', seatsTogether: true, directPurchaseUrl: 'https://www.stubhub.com/metallica-uncasville-tickets-11-19-2026/event/1559/?listingId=L-8812', collectionMode: 'approved_api', ...over });
}

function render(offer: Offer, extra: Partial<BuildPacketArgs> = {}) {
  const best = evaluateOffer(offer, constraints, FIXTURE_EVENT_ID);
  const packet = buildPacket({ requestId: 'r1', revision: 1, quantity: 2, eventLabel: 'Metallica — Mohegan Sun Arena', eventParts: { title: 'Metallica', where: 'Mohegan Sun Arena, Uncasville', when: 'Thu, Nov 19, 8:00 PM EST' }, eventCategory: 'concert', artworkUrl: 'https://app.ticketguy.example/email/ticket-brief-concert.jpg', best, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null, policy: decide(policyInput), priorities, sourcesChecked: ['stubhub'], sourcesUnavailable: [], independentOptionCount: 1, observedAt: NOW, evidenceExpiresAt: null, basketKey: 'b1', watchConsentReference: null, isFixture: true, ...extra });
  const r = validateAndRender(packet, { decision: packet.decision, opening: 'Here is what I found.', paragraphs: [{ claimIds: ['C_BEST'], prose: 'The pick.' }], closing: 'Reply if you want something else.' });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { packet, ...r };
}

describe('the verified-offer brief', () => {
  it('every fact checked: the lime card, the seller’s listing as the one button, the artwork, and no plain repeat of the claim', () => {
    const { textBody, htmlBody } = render(checked());
    expect(textBody.startsWith('Hey,\n\nThese are the two I’d take.\n\nIt’s the lowest checked total for two together among the offers I checked, $316 inside your $2,500. StubHub showed the total with fees and the seats together when I checked.')).toBe(true);
    expect(textBody).toContain('Metallica\nMohegan Sun Arena, Uncasville\n');
    expect(textBody).toContain('My pick · checkout checked\nSection 111 · Row L\n$2,184 for two\n$1,092 a ticket, fees included\nThe seller’s checkout total, fees included.\nSeats together: Confirmed\nSeller: StubHub');
    expect(textBody).toContain('View these seats on StubHub: https://www.stubhub.com/metallica-uncasville-tickets-11-19-2026/event/1559/?listingId=L-8812');
    expect(textBody).toContain('Not held; availability can change.');
    expect(textBody).not.toContain('Estimated total');
    // The claim's own sentence and a second link list aren't added under the card.
    expect(textBody).not.toContain('including the verified charges');
    expect(textBody.match(/listingId=L-8812/g)).toHaveLength(1);
    expect(htmlBody).toContain('background:#d7f36b;');
    expect(htmlBody).toMatch(/<td bgcolor="#142438"[^>]*><a href="https:\/\/www\.stubhub\.com\/[^"]+listingId=L-8812"[^>]*>View these seats on StubHub&nbsp;↗<\/a>/);
    expect(htmlBody).toContain('<img src="https://app.ticketguy.example/email/ticket-brief-concert.jpg" alt="" role="presentation"');
    expect(htmlBody).toContain('Concert / Your ticket brief');
  });

  it('a check older than ten minutes is not "checkout checked": the plain claim stays', () => {
    const { textBody, htmlBody } = render(checked({ observedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString() }));
    expect(textBody).not.toContain('checkout checked');
    expect(textBody).toContain('2 seats together in section 111: $2,184 total');
    expect(htmlBody).not.toContain('#d7f36b');
  });

  it('no listing id, a link off the seller’s own site, seats not confirmed together or an estimated total: no brief', () => {
    for (const over of [{ providerListingId: null }, { directPurchaseUrl: 'https://www.vividseats.com/production/1?ticketId=1' }, { directPurchaseUrl: 'http://www.stubhub.com/event/1559/?listingId=L-8812' }, { seatsTogether: null }, { availability: 'unknown' as const }] satisfies Array<Partial<Offer>>) {
      const { packet } = render(checked(over));
      expect(packet.claimRecords.find((c) => c.id === 'C_BEST')?.card?.brief, JSON.stringify(over)).toBeUndefined();
    }
  });

  it('customer and listing text is escaped on the card', () => {
    const { htmlBody } = render(checked(), { eventParts: { title: 'Bad <script>alert(1)</script> & Co', where: 'Hall "A"', when: 'Thu' } });
    expect(htmlBody).not.toContain('<script>');
    expect(htmlBody).toContain('Bad &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(htmlBody).toContain('Hall &quot;A&quot;');
  });
});

describe('the brief card itself', () => {
  const lead: TicketBrief = { kind: 'price_lead', headline: 'A price lead for two: about $247.', rationale: 'r', category: 'NHL', event: { name: 'Rangers vs. Canucks', where: 'MSG', when: 'Sat' }, artworkUrl: 'http://insecure.example/a.jpg', seatLine: 'Section 101 · Row 10', total: 'About $247', forWhom: 'for two', basis: ['$190 before fees ($95 each). Includes a 30% fee allowance.'], facts: [['Seats together', 'Not confirmed'], ['Listed on', 'StubHub']], action: { label: 'Search StubHub for this game', url: 'https://www.stubhub.com/search?q=x' }, secondary: null, actionNote: 'n', affiliate: false, alternatives: [1, 2, 3].map((i) => ({ label: `Alt ${i}`, totalCents: 20000 + i, basis: 'before fees' as const, note: '' })), after: [], evidenceNote: 'e' };

  it('a lead: neutral badge, outlined search button, "estimated" beside the amount, at most two alternatives, no insecure image', () => {
    const { html, text } = briefCard(lead);
    const h = html.join('');
    expect(h).toContain('background:#e9e3d8;');
    expect(h).toContain('<td bgcolor="#ffffff"');
    expect(h).not.toContain('<td bgcolor="#142438"');
    expect(h).toContain('Estimated total; checkout price unconfirmed.');
    expect(h).not.toContain('<img');
    expect(text.join('\n')).toContain('Other price leads\nAlt 1: $200.01 before fees.');
    expect(text.join('\n')).not.toContain('Alt 3');
  });

  it('without the event block when the header already names it', () => {
    const { text, html } = briefCard({ ...lead, artworkUrl: 'https://ok.example/a.jpg' }, { withEvent: false });
    expect(text.join('\n')).not.toContain('Rangers vs. Canucks');
    expect(html.join('')).not.toContain('<img');
  });
});

describe('labels', () => {
  it('names the kind of event, and every catalog sport is a game', () => {
    expect(categoryLabel('concert')).toBe('Concert');
    expect(categoryLabel('nhl')).toBe('NHL');
    expect(categoryLabel(null)).toBe('Event');
    expect(eventNounFor('minor_league')).toBe('game');
    expect(eventNounFor('ncaa_regular')).toBe('game');
    expect(isLiveMusic('festival')).toBe(true);
    expect(isLiveMusic('nhl')).toBe(false);
  });
});

describe('the brief’s title and headline read plainly (live Oct 9)', () => {
  it('a college game’s title drops the sport after each team, and keeps Men’s or Women’s', async () => {
    const { briefTitle } = await import('@/lib/advice/packet');
    expect(briefTitle('Notre Dame Fighting Irish Football vs. Miami Hurricanes Football')).toBe('Notre Dame Fighting Irish vs. Miami Hurricanes');
    expect(briefTitle("UConn Huskies Women's Basketball vs. South Carolina Gamecocks Women's Basketball")).toBe("UConn Huskies Women's Basketball vs. South Carolina Gamecocks Women's Basketball");
    expect(briefTitle('New York Rangers vs. New York Islanders')).toBe('New York Rangers vs. New York Islanders');
    expect(briefTitle('Metallica')).toBe('Metallica');
  });
});
