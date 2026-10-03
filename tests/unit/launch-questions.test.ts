import { describe, expect, it } from 'vitest';
import { BUDGET_WORDS, TREND_ASKED, linkedSubject } from '@/lib/intake/pipeline';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import { clarificationQuestions } from '@/lib/ai/extraction';
import { namedRows, shownPriceParts } from '@/lib/advice/shown-prices';
import { evidenceAsks } from '@/lib/advice/evidence-answer';
import { areaIntent, type ShownOffer } from '@/lib/ai/listing-evidence';

/**
 * Final launch review, Workstream C: the buyer's words, varied. A cap is not a quote, a tier named without its price
 * is still that row, two rows at one price stay two rows, and every timing phrasing is a timing question.
 */
const row = (label: string, cents: number): ShownOffer => ({ label, perTicketCents: cents, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'resale', admission: 'standing' }) as ShownOffer;
const T3 = row('GA Ticket Price Tier 3: While Supplies Last', 11329);
const T2 = row('GA Ticket Price Tier 2: While Supplies Last', 11806);
const BAL = row('Balcony: Standing Room Only', 10400);

describe('money roles (A02)', () => {
  it.each([
    'We can do $220 for both.',
    'Actually we could do $220 for the pair',
    "I'd pay $110 each, tops",
    'We can go up to $250 total',
    'I could stretch to $300 for both',
    'We have $220 for both, including fees',
    'Budget is $220',
  ])('a cap: %s', (s) => expect(BUDGET_WORDS.test(s)).toBe(true));
  it.each([
    'These are $220 for both.',
    'Tier 3 is $226.58 for the two of us.',
    'The listing says $113.29 each',
    'I do $5 shows sometimes',
  ])('a quote or nothing, not a cap: %s', (s) => expect(BUDGET_WORDS.test(s)).toBe(false));
});

describe('rows named by their labels (A03)', () => {
  it('tier labels alone compare in cents, in either order', () => {
    for (const text of ['Tier 2 or tier 3, which is cheaper for the two of us?', 'Which is cheaper for two: tier 3 or tier 2?', 'Is tier 3 or tier 2 cheaper for both of us?']) {
      const out = shownPriceParts({ rows: [BAL, T3, T2], chosen: null, quantity: 2, budgetCents: null, text, beforeTaxes: true });
      expect(out[0]).toBe('GA Ticket Price Tier 3 is cheaper: $226.58 for two, against $236.12 for GA Ticket Price Tier 2, so $9.54 less.');
    }
  });

  it('two rows at the same price stay two rows', () => {
    const a = row('Section 101', 15000);
    const b = row('Section 102', 15000);
    expect(namedRows('section 101 or section 102 at $150 each?', [a, b])).toHaveLength(1); // one quoted price names one row
    const out = shownPriceParts({ rows: [a, b], chosen: null, quantity: 2, budgetCents: null, text: 'Which is cheaper, the $150 one or the other $150 one?', beforeTaxes: null });
    expect(out[0]).toBe('Section 101 and Section 102 cost the same: $300 for two either way.');
  });

  it('either of these floor options: both against the saved cap, tax separately (A04)', () => {
    const text = 'Same budget, still floor only. Can we afford either of these floor options now? Is tax included?';
    expect(areaIntent(text).want).toBe('floor');
    const out = shownPriceParts({ rows: [BAL, T3, T2], chosen: null, quantity: 2, budgetCents: 22000, text, beforeTaxes: true });
    expect(out).toEqual([
      'No, neither fits your $220: GA Ticket Price Tier 3 is $226.58 for two ($6.58 over) and GA Ticket Price Tier 2 is $236.12 for two ($16.12 over).',
      'Those prices include fees but not tax, so tax is added on top at checkout.',
    ]);
  });
});

describe('timing questions (A15)', () => {
  it.each([
    'Is this a good deal for two or should I hold off?',
    "Ok, what would you do in my position? We can wait a couple of days but don't want to miss the game.",
    'Would you buy now or later?',
    'What would you do in our shoes?',
    'Should we hold off until next week?',
    'Is it worth waiting?',
  ])('%s', (s) => expect(TREND_ASKED.test(s)).toBe(true));
  it.each(['Hold off on the alerts please, just tell me the cheapest.', 'What section would you pick?'])('not timing: %s', (s) => expect(TREND_ASKED.test(s)).toBe(false));
});

describe('screenshot questions (A05–A09)', () => {
  it('reads each question kind from varied wording', () => {
    expect(evidenceAsks('When should we get there — what time do doors open?').times).toBe(true);
    expect(evidenceAsks('Are the floor tickets seats or standing?').admission).toBe(true);
    expect(evidenceAsks('Which one do I click for just the regular show?').product).toBe(true);
    expect(evidenceAsks('Can my friend use the other night?').split).toBe(true);
    expect(evidenceAsks('It says sold out — is a hotel package the only way?').soldOut).toBe(true);
    expect(evidenceAsks('Can you explain what each screenshot is offering?').explain).toBe(true);
    expect(evidenceAsks('Great, thanks!')).toEqual({ times: false, admission: false, product: false, split: false, soldOut: false, explain: false, prices: false });
  });
});

describe('reply wording (Workstream E)', () => {
  const at = new Date('2026-10-02T17:30:00Z');
  const base = (over: Record<string, unknown>) => ({
    requestId: 'r', revision: 1, quantity: 2, eventLabel: 'New York Rangers vs. New York Islanders', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
    sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    market: null, official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/RANGERS' }, faceValue: null, subject: null, quote: null,
    timeZone: 'America/New_York', eventLocalDate: '2026-10-06', eventStartAt: new Date('2026-10-06T23:30:00Z'), eventNoun: 'game',
    ...over,
  }) as unknown as BuildPacketArgs;
  const text = (a: BuildPacketArgs) => buildPacket(a).claimRecords.filter((c) => c.customerVisible).map((c) => c.text).join('\n');

  it('a StubHub listing found by its number is resale: never "if it’s Ticketmaster’s own price"', () => {
    const sub = linkedSubject({ listingId: '1', marketplace: 'stubhub', priceCents: 15500, quantity: 2, section: '112', row: '2' } as never, 'StubHub', 2, at);
    const said = text(base({ subject: sub, quote: { perTicketCents: 15500, assumedPerTicket: false, source: 'link_match', feeBasis: 'before_fees', seenAt: at, seller: 'StubHub' }, link: { marketplace: 'StubHub', eventPage: false } }));
    expect(sub.listingType).toBe('resale');
    expect(said).not.toMatch(/Ticketmaster’s own (?:price|ticket)|it’s face value|face value, not a resale markup/);
  });

  it('a listing not matched in the feed is "couldn’t match", never "StubHub doesn’t pass me prices"', () => {
    const said = text(base({ link: { marketplace: 'StubHub', eventPage: false }, askedText: 'Is this a good deal for two?' }));
    expect(said).toContain('I couldn’t match the StubHub listing you picked in the listing data I can see');
    expect(said).not.toMatch(/doesn’t pass me|never (?:gives|passes)/);
  });

  it('a link they already sent is never asked for again', () => {
    const withLink = clarificationQuestions(['event'], { performerOrTeam: null, submittedUrls: ['https://broadwaydirect.com/show/hamilton/'] } as never);
    expect(withLink.join(' ')).not.toMatch(/A link (?:works|or screenshot|to the event)/);
    expect(clarificationQuestions(['event'], { performerOrTeam: null, submittedUrls: [] } as never).join(' ')).toContain('A link or screenshot works.');
  });
});
