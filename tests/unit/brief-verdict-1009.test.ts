import { describe, expect, it } from 'vitest';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { pickListings, type MarketListing } from '@/lib/market/alternatives';
import type { MarketContext } from '@/lib/market/series';

/**
 * Live, Oct 9 2026, Notre Dame vs Miami, two tickets, $1,500: the brief opened "Nothing for two fits your $1,500 yet.",
 * said the per-ticket price and the budget gap twice, showed "Up and down" over prices listed newest first, ran the
 * seven past games into a long paragraph, put a full-width banner above the price, and gave StubHub the big button
 * though the feed didn't say which marketplace had the seats. The review: one verdict, one supporting trend, one next
 * step, understood in five seconds.
 */
const at = new Date('2026-10-09T16:00:00Z');
const game = new Date('2026-11-07T17:00:00Z');
const listing = (priceCents: number, quantity: number, section: string, row: string): MarketListing => ({ priceCents, quantity, section, row, marketplace: null, id: null, zone: null, url: null } as unknown as MarketListing);
const market = (over: Partial<MarketContext> = {}): MarketContext => ({
  methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 70801, at: new Date(at.getTime() - 30 * 60_000), activeListings: 40 },
  h24: { hours: 24, fromCents: 65252, toCents: 70801, changeCents: 5549, pct: 5549 / 65252 }, h72: { hours: 72, fromCents: 69770, toCents: 70801, changeCents: 1031, pct: 1031 / 69770 },
  direction: 'mixed', supply: { trend: 'unknown', now: 40, before: null, hours: null }, typical: null, points: 40,
  late: { events: 7, fell: 5, rose: 1, held: 1, medianPct: -0.45, leadBucket: '14-30d' }, ...over,
});
const args = (m: MarketContext, watchOffer: { until: Date } | null, budget = 150000) => {
  const chosen = pickListings([listing(70807, 2, '119', '26'), listing(76000, 4, '120', '12')], 2, budget, 30)!;
  return {
    requestId: 'r', revision: 1, quantity: 2, eventLabel: 'Notre Dame Fighting Irish vs. Miami Hurricanes at Notre Dame Stadium', eventParts: { title: 'Notre Dame Fighting Irish vs. Miami Hurricanes', where: 'Notre Dame Stadium, Notre Dame', when: 'Sat, Nov 7, 12:00 PM EST' }, eventStartAt: game, headerStartAt: game, timeZone: 'America/Indiana/Indianapolis', eventCategory: 'ncaaf', eventNoun: 'game',
    best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: budget, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
    sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    market: { basis: 'pair', context: m, supply: m.supply, supplyScope: 'group', visible: true },
    picks: { ...chosen, age: 'recent', links: [{ label: 'Search StubHub for this game', url: 'https://www.stubhub.com/search?q=nd' }, { label: 'Search Vivid Seats for this game', url: 'https://www.vividseats.com/search?searchTerm=nd' }] },
    watchOffer,
  } as unknown as BuildPacketArgs;
};
const email = (a: BuildPacketArgs) => {
  const p = buildPacket(a);
  const r = validateAndRender(p, { decision: p.decision, opening: '', paragraphs: [{ claimIds: [], prose: '' }], closing: '' });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r;
};

const h = (hours: number, from: number, to = 70801) => ({ hours, fromCents: from, toCents: to, changeCents: to - from, pct: (to - from) / from });
const SOON = { until: new Date('2026-11-06T17:00:00Z') };

describe('what I’d do, why, and the next action: the outcome follows their budget, the trend, history and time', () => {
  it('4. over budget, a drop could come (past games here usually fell late), a watch can run: hold off, watch it', () => {
    const { textBody: text, htmlBody: html } = email(args(market(), SOON));
    const top = text.slice(0, text.indexOf('How prices are moving'));
    expect(top).toContain('I’d hold off: you don’t need to stretch your budget yet.');
    expect(text).not.toMatch(/Nothing for two fits|overpriced/);
    expect(top).toContain('The closest lead is Section 119, Row 26: about $1,841 for two tickets, including estimated fees, against your $1,500 cap. The checkout total and whether the seats are together haven’t been confirmed.');
    expect(top).toContain('Yesterday’s dip has reversed. The cheapest listed pair is up 8.5% since yesterday, but only 1.5% above three days ago. There’s no sustained fall yet.');
    expect(top).toContain('Late drops happened in 5 of 7 previous games here we tracked. That’s the cheapest listed pair across the venue, not these seats, so it’s a reason to keep watching, not a promise they’ll get cheaper.');
    expect(text).toContain('How prices are moving: dip reversed\n3 days ago: $1,395\nYesterday: $1,305 (▼ $90)\nNow: $1,416 (▲ $111)\nThe cheapest listed pair, before fees, from StubHub and Vivid Seats.');
    // One price prominent; the base and allowance secondary; the per-ticket price once; one caveat.
    expect(text).toContain('About $1,841 for two · estimated fees included\nAbout $920 a ticket\n$1,416.14 before fees ($708.07 each). Includes a 30% fee allowance.');
    expect(text.match(/\$920/g)).toHaveLength(1);
    expect(text).not.toMatch(/Estimated total; checkout price unconfirmed|not checked yet/);
    // The watch is the next step; seller searches are plain links, not a button claiming we know the seller.
    expect(text).toContain('Want me to watch your $1,500 target? Reply “watch it” and I’ll keep checking until');
    expect(text).toContain('Search StubHub for this game: https://www.stubhub.com/search?q=nd\nSearch Vivid Seats for this game: https://www.vividseats.com/search?searchTerm=nd');
    expect(html).not.toContain('↗');
    // Decision, price and trend before the card.
    expect(text.indexOf('I’d hold off')).toBeLessThan(text.indexOf('Notre Dame Stadium'));
    expect(text.indexOf('How prices are moving')).toBeLessThan(text.indexOf('Price lead · still needs checking'));
  });

  it('5. over budget and no watch can run: no indefinite waiting, one question that unlocks it, never a raised budget', () => {
    const { textBody: text, htmlBody: html } = email(args(market(), null));
    expect(text).toContain('I haven’t found a confirmed pair under $1,500.');
    expect(text).toContain('The closest lead is Section 119, Row 26: about $1,841 for two tickets, including estimated fees, $341 over.');
    expect(text).toContain('Would you go up to about $1,841 for these, or should I look at other seats or another date?');
    expect(text).not.toMatch(/hold off|watch it|How prices are moving/);
    expect(html).not.toContain('↗');
  });

  it('5. over budget, rising, no history: says it isn’t moving toward their target, and asks', () => {
    const { textBody: text } = email(args(market({ direction: 'up', h24: h(24, 66000), h72: h(72, 64000), late: null }), SOON));
    expect(text).toContain('I haven’t found a confirmed pair under $1,500.');
    expect(text).toContain('Prices are rising.');
    expect(text).toContain('Would you go up to about $1,841');
    expect(text).not.toMatch(/watch it/);
  });

  it('1. within budget, no clear trend: go for these, no trend block, the direct listing as the button', () => {
    const a = args(market({ late: null }), null, 200000);
    const linked = { ...a, picks: { ...a.picks!, links: [{ label: 'View Section 119 on StubHub', url: 'https://www.stubhub.com/event/123/?quantity=2&listingId=9' }] } } as BuildPacketArgs;
    const { htmlBody: html, textBody: text } = email(linked);
    expect(text).toContain('I’d go for these if checkout comes to about $1,841 for two.');
    expect(text).toContain('Section 119, Row 26: about $1,841 for two tickets, including estimated fees, $159 under your $2,000.');
    expect(text).not.toMatch(/How prices are moving|hold off|Late drops/);
    expect(html).toContain('View Section 119 on StubHub&nbsp;↗');
  });

  it('2. within budget, rising: buy if set on going; the rise supports it, doesn’t prove tomorrow costs more', () => {
    const { textBody: text } = email(args(market({ direction: 'up', h24: h(24, 66000), h72: h(72, 64000), late: null }), null, 200000));
    expect(text).toContain('I’d buy these if you’re set on going.');
    expect(text).toContain('Comparable pairs have risen 11% over three days. That supports buying; it doesn’t prove tomorrow will cost more.');
    expect(text).toContain('How prices are moving: rising');
    expect(text).not.toMatch(/last chance|act now/i);
    // Pricier seats under a pick we'd buy don't change the decision.
    expect(text).not.toContain('Other price leads');
  });

  it('3. within budget, falling, other options fit and time to wait: give it another day', () => {
    const a = args(market({ direction: 'down', h24: h(24, 74000), h72: h(72, 80000), late: null }), null, 400000);
    const { textBody: text } = email(a);
    expect(text).toContain('I’d give it another day.');
    expect(text).toContain('Comparable pairs have fallen 11% over three days. Waiting could improve the price, although this particular pair may go.');
    // The other option that fits is what makes waiting reasonable: shown.
    expect(text).toContain('Other price leads');
  });

  it('3. within budget, falling, but only these fit: take them for the seats', () => {
    const { textBody: text } = email(args(market({ direction: 'down', h24: h(24, 74000), h72: h(72, 80000), late: null }), null, 190000));
    expect(text).toContain('I’d take these: they’re the only pair inside your budget.');
    expect(text).toContain('Comparable pairs have fallen 11% over three days, but waiting means risking these seats.');
  });

  it('3. within budget, falling, but the game is in two days: buy now', () => {
    const a = args(market({ direction: 'down', h24: h(24, 74000), h72: h(72, 80000), late: null }), null, 400000);
    const { textBody: text } = email({ ...a, eventStartAt: new Date(at.getTime() + 2 * 86_400_000) } as BuildPacketArgs);
    expect(text).toContain('I’d buy these now: there isn’t much time left to wait.');
  });

  // Audit gap 21, owner framework case 4: with WATCH_SEND_ENABLED off there is never a watch, so "hold off" could
  // never be said and a falling, over-budget party always got a question back. The fall in their own series is
  // reason enough to hold, with a day to look again (venue time) and the one thing that would change the answer.
  it('4. over budget, falling with weeks to go, no watch can run: hold off for now, check back on a named day', () => {
    const { textBody: text, htmlBody: html } = email(args(market({ direction: 'down', h24: h(24, 74000), h72: h(72, 80000), late: null }), null));
    const top = text.slice(0, text.indexOf('How prices are moving'));
    expect(top).toContain('I’d hold off for now.\n\nComparable pairs have fallen 11% over three days, and nothing for two fits your $1,500 yet.');
    expect(top).toContain('The closest lead is Section 119, Row 26: about $1,841 for two tickets, including estimated fees, $341 over.');
    // A day on from Friday, Oct 9 at noon in Indiana: never a time we can't keep, never "I'll watch".
    expect(top).toContain('Check back on Saturday, Oct 10; if you can go up to about $1,841 for two, I’d take these now instead.');
    expect(text).toContain('How prices are moving: falling');
    expect(text).not.toMatch(/watch it|keep checking|I’ll email you|Would you go up/);
    expect(html).not.toMatch(/[\u2013\u2014]/);
    expect(text.indexOf('I’d hold off')).toBeLessThan(text.indexOf('Check back on')); // what I'd do, why, then the next action
  });

  it('5. over budget and falling, but the game is in two days: no time to hold, so it asks', () => {
    const a = args(market({ direction: 'down', h24: h(24, 74000), h72: h(72, 80000), late: null }), null);
    const { textBody: text } = email({ ...a, eventStartAt: new Date(at.getTime() + 2 * 86_400_000) } as BuildPacketArgs);
    expect(text).toContain('I haven’t found a confirmed pair under $1,500.');
    expect(text).toContain('Would you go up to about $1,841');
    expect(text).not.toMatch(/hold off|Check back/);
  });

  it('5. over budget, a fall the series can’t support (thin): keeps the question, never a hold', () => {
    const { textBody: text } = email(args(market({ direction: 'down', adequacy: 'insufficient', h24: h(24, 74000), h72: h(72, 80000), late: null }), null));
    expect(text).toContain('Would you go up to about $1,841');
    expect(text).not.toMatch(/hold off|Check back|Comparable pairs have fallen/);
  });

  it('3. no budget given, falling, only one option: never "inside your budget"', () => {
    const a = args(market({ direction: 'down', h24: h(24, 74000), h72: h(72, 80000), late: null }), null, 190000);
    const one = { ...a, priorities: { ...a.priorities, budgetTotalCents: null }, picks: { ...a.picks!, ...pickListings([listing(70807, 2, '119', '26')], 2, null, 30)! } } as BuildPacketArgs;
    const { textBody: text } = email(one);
    expect(text).toContain('I’d take these: they’re the only pair I can see for you.');
    expect(text).not.toMatch(/inside your budget|within your/);
  });
});
