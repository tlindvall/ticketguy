import { describe, expect, it } from 'vitest';
import { suppliedOffers } from '@/lib/intake/pipeline';
import { suppliedOffersAnswer } from '@/lib/advice/packet';
import { concertQuestion, youngestAttendee } from '@/lib/advice/concert-terms';
import { offerTotal, offersInText, partyTerms } from '@/lib/advice/text-offers';
import { suppliedTrendQuestion } from '@/lib/advice/supplied-trend';

const NOW = new Date('2026-09-30T23:00:00Z');
function compare(messages: string[]) {
  const { textOffers } = suppliedOffers(messages.at(-1)!, messages, 'America/New_York');
  return { offers: textOffers, ...suppliedOffersAnswer({ offers: textOffers, quantity: 2, budgetTotalCents: 30000, needs: { terms: partyTerms(messages), noObstructed: false, togetherRequired: false, baseline: null }, accessibilityRequired: false, timeZone: 'America/New_York', observedAt: NOW }) };
}
const tickets = (a: string, b: string) => `Two adults need concert admission. Offer A: two concert admissions $80 TOTAL all-in, ${a}. Offer B: two concert admissions $100 TOTAL all-in, ${b}. Which fits?`;

describe('concert eligibility is decided before price', () => {
  for (const status of ['SOLD OUT', 'unavailable', 'not purchasable', 'no longer available']) it(`rejects the cheaper ${status} quote`, () => {
    const r = compare([tickets(status, 'available')]);
    expect(r.lead).toMatch(/^Offer B.*\$100/);
    expect(r.items[0]).toMatch(/unavailable/);
  });
  it('a stock-only correction restores A, while a subsequent price-only correction retains its stock', () => {
    const first = tickets('sold out', 'available');
    expect(compare([first, 'A is now back in stock. Offers and prices unchanged.']).lead).toMatch(/^Offer A.*\$80/);
    expect(compare([first, 'A is now back in stock. Offers and prices unchanged.', "A's price is now $90 TOTAL all-in. B unchanged."]).lead).toMatch(/^Offer A.*\$90/);
  });
  it('a negative sold-out status is not read as sold out', () => {
    expect(compare([tickets('not sold out, now available', 'available')]).lead).toMatch(/^Offer A/);
  });
  for (const day of ['FRIDAY-ONLY festival admission', 'festival admission not valid on Saturday']) it(`does not sell a wrong-day ticket: ${day}`, () => {
    const r = compare([`Two adults only want Saturday festival admission. Offer A: two ${day} $80 TOTAL all-in. Offer B: two SATURDAY-ONLY festival admissions $100 TOTAL all-in. Which fits?`]);
    expect(r.lead).toMatch(/^Offer B.*\$100/);
    expect(r.items[0]).toMatch(/not valid.*saturday/i);
  });
  it('an explicit replacement day updates validity instead of retaining a contradictory old exclusion', () => {
    const first = 'Two adults only want Saturday festival admission. Offer A: two FRIDAY-ONLY festival admissions $80 TOTAL all-in, not valid Saturday. Offer B: two SATURDAY-ONLY festival admissions $100 TOTAL all-in.';
    expect(compare([first, "A's terms are corrected: SATURDAY-ONLY festival admission. Same offers and prices."]).lead).toMatch(/^Offer A/);
  });
  it('an unknown view cannot satisfy a mandatory full-view requirement', () => {
    const r = compare([`We need two country concert seats with a full unobstructed view. ${tickets('view not stated', 'unobstructed view')}`]);
    expect(r.lead).toMatch(/^Offer B.*\$100/);
    expect(r.items[0]).toMatch(/view is not established/);
  });
  for (const view of ['not an unobstructed view', 'unobstructed advertised, but restricted view with a pillar']) it(`explicit view exclusions override reassuring wording: ${view}`, () => {
    expect(compare([`We need two country concert seats with a full unobstructed view. ${tickets(view, 'unobstructed view')}`]).lead).toMatch(/^Offer B/);
  });
  it('lifting the view requirement explicitly makes the restricted cheaper seats eligible', () => {
    const first = `We need two country concert seats with a full unobstructed view. ${tickets('restricted view', 'unobstructed view')}`;
    expect(compare([first, 'Restricted views are now acceptable. Same offers.']).lead).toMatch(/^Offer A.*\$80/);
  });
  it('nontransferable admission cannot win on price', () => {
    expect(compare([tickets('NONTRANSFERABLE', 'official transferable tickets')]).lead).toMatch(/^Offer B/);
  });
  it('transfer permission does not erase a separate original-purchaser collection restriction', () => {
    const first = tickets('NONTRANSFERABLE; wristbands collectible with original purchaser ID; seller is not attending', 'official transferable tickets');
    expect(compare([first, 'A is now official transferable tickets. All other offers and collection terms unchanged.']).lead).toMatch(/^Offer B/);
    expect(compare([first, 'A is now official transferable tickets. All other offers and collection terms unchanged.']).items[0]).toContain('original purchaser');
  });
});

describe('package entitlement and fee arithmetic', () => {
  it('one package can admit two people; it cannot magically admit three', () => {
    const text = 'Two adults want a concert. Offer A: one VIP package $90 TOTAL including TWO concert admissions and merch, all-in. Offer B: two concert admissions $120 TOTAL all-in.';
    const r = compare([text]);
    expect(r.lead).toMatch(/^Offer A.*\$90/);
    expect(offerTotal(r.offers[0]!, 3)).toBeNull();
  });
  it('two packages including two admissions in total do not manufacture four admissions', () => {
    const r = compare(['Two adults want a concert. Offer A: two VIP packages, including two concert admissions and merch, $180 TOTAL all-in. Offer B: two concert admissions $200 TOTAL all-in.']);
    expect(r.offers[0]!.quantity).toBe(2);
    expect(r.offers[0]!.admissionsPerUnit).toBeNull();
    expect(offerTotal(r.offers[0]!, 2)?.tickets).toBe(2);
  });
  it('a descriptive correction retains the regular pair and removes all entry from the bundle', () => {
    const r = compare(['Two adults need concert tickets. Offer A: one VIP package $90 TOTAL including TWO concert admissions and merch, all-in. Offer B: two ordinary concert admissions $120 TOTAL all-in.', 'The cheap bundle is merch only. Zero entry tickets. Keep the regular pair and all other facts.']);
    expect(r.lead).toMatch(/^Offer B.*\$120/);
    expect(r.items[0]).toContain('no concert admission');
  });
  it('a global need for admission never turns parking into an admission product', () => {
    expect(compare(['Two adults need actual concert admission. Copied offers for actual admission: Offer A: parking only $20 EACH all-in. Offer B: two concert admissions $100 TOTAL all-in.']).lead).toMatch(/^Offer B/);
  });
  it('a fee declaration attached to B does not leak into A', () => {
    const offers = offersInText('Two adults need concert admission. Offer A: two concert admissions $50 EACH, fees unknown. Offer B: two concert admissions $60 EACH including fees.');
    expect(offers[0]!.feeBasis).not.toBe('all_in');
  });
  it('a before-fees condition preceding the price overrides shared all-in wording', () => {
    const offers = offersInText('Copied quotes all-in except where stated: Offer A: two concert admissions BEFORE FEES $50 EACH. Offer B: two concert admissions $60 EACH including fees.');
    expect(offerTotal(offers[0]!, 2)?.allIn).toBe(false);
  });
  it('per-ticket fees on a supplied order total are applied to admissions once', () => {
    const r = compare([tickets('available', 'available'), "A's checkout adds a $12 fee per ticket on top of its $80 TOTAL. Other offers and terms unchanged."]);
    expect(offerTotal(r.offers[0]!, 2)?.cents).toBe(10400);
    expect(r.lead).toMatch(/^Offer B.*\$100/);
  });
});

describe('minors: attendee facts, guardian thresholds and ID alternatives', () => {
  const plan = 'Both of us are 16, going without adults to an indie concert. Copied policy: minimum age 16; ages 16 and above may enter unaccompanied; ';
  for (const ids of ['government-issued photo ID OR school-issued photo ID', 'school-issued photo ID or government-issued photo ID']) it(`accepts school ID as a permitted alternative: ${ids}`, () => {
    expect(concertQuestion([`${plan}${ids} accepted. We only have school photo IDs. Can we enter alone?`])?.lead).toContain('both meet');
  });
  it('does not turn two required IDs into an either/or choice', () => {
    expect(concertQuestion([`${plan}bring government-issued photo ID AND school-issued photo ID. We only have school photo IDs. Can we enter alone?`])?.lead).not.toContain('both meet');
  });
  it('an explicitly disallowed school ID is not an accepted alternative', () => {
    expect(concertQuestion([`${plan}government-issued photo ID accepted; school-issued photo ID is not accepted. We only have school photo IDs. Can we enter alone?`])?.lead).not.toContain('both meet');
  });
  it('changing one age retains the other attendee rather than applying it to the whole party', () => {
    const first = 'For a concert, our two attendees are 17 and 15, without adults. Policy: minimum age 16.';
    expect(youngestAttendee([first, 'Correction: the younger attendee is 18, not 15. Older attendee still 17.'])).toBe(17);
    expect(partyTerms([first]).attendees).toBe(2);
  });
  it('policy age thresholds never manufacture an attendee age', () => {
    expect(youngestAttendee(['At this concert, the policy says both 16 and 17-year-olds need ID. We have not given our ages.'])).toBeNull();
  });
  it('a prohibition scoped to under16 does not forbid eligible sixteen-year-olds', () => {
    expect(concertQuestion([`${plan}under-16s may NOT enter unaccompanied; school-issued photo ID accepted. We only have school photo IDs. Can we enter alone?`])?.lead).toContain('both meet');
  });
});

describe('entry cutoff and supplied trend comparisons', () => {
  const first = 'Two adults for an electronic night Friday October 2, 2026, doors 9pm. We arrive at 11pm that Friday. Offer A: two concert admissions $40 TOTAL all-in, entry strictly before 11pm. Offer B: two concert admissions $70 TOTAL all-in, anytime entry.';
  it('strictly-before excludes the exact boundary; a same-date earlier arrival qualifies', () => {
    expect(compare([first]).lead).toMatch(/^Offer B/);
    expect(compare([first, "We'll arrive at 10:30pm Friday October 2. Same offers and prices."]).lead).toMatch(/^Offer A/);
  });
  for (const [number, quantity] of [['three', 3], ['7', 7]] as const) it(`incompatible ${number}-person snapshots produce arithmetic, not a prediction`, () => {
    const reply = suppliedTrendQuestion([`I need ${number} seats together for a concert. Budget $900 TOTAL. Yesterday one upper-level seat was $80 before fees. Today ${number} lower-level seats together for $100 each including fees. Does that prove prices went up?`]);
    expect(reply?.lead).toContain('cannot establish a trend');
    expect(reply?.items.join(' ')).toContain(`$${quantity * 100}`);
    expect(reply?.items.join(' ')).toContain(`${quantity} adjacent seats`);
    expect(reply?.items.join(' ')).not.toMatch(/five|550/);
  });
  it('comparable supplied baskets are not falsely labelled incompatible', () => {
    expect(suppliedTrendQuestion(['For the same concert, yesterday two lower-level seats together were $90 each including fees. Today two lower-level seats together for $80 each including fees. Are prices trending down?'])).toBeNull();
  });
  it('decimal prices are not truncated at sentence boundaries', () => {
    const reply = suppliedTrendQuestion(['I need three seats together for a concert. Yesterday one upper-level seat was $80.50 before fees. Today three lower-level seats together for $110.25 each including fees. Do these data points establish a trend?']);
    expect(reply?.items.join(' ')).toContain('$330.75');
  });
});
