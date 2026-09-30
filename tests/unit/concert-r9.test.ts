import { describe, expect, it } from 'vitest';
import cases from '../fixtures/qa-concert-r9.json';
import { suppliedOffers } from '@/lib/intake/pipeline';
import { suppliedOffersAnswer } from '@/lib/advice/packet';
import { admissionTerms, concertBudget, concertQuestion, entryFailure, entryTerm, nightTiming } from '@/lib/advice/concert-terms';
import { offerTotal, partyTerms, offersInText } from '@/lib/advice/text-offers';

const messages = (id: string, turn = 99) => cases.find((c) => c.id === id)!.messages.slice(0, turn);
function compare(id: string, turn: number, budget: number) {
  const ms = messages(id, turn);
  const { textOffers } = suppliedOffers(ms.at(-1)!, ms, 'America/New_York');
  const terms = partyTerms(ms);
  return { offers: textOffers, ...suppliedOffersAnswer({ offers: textOffers, quantity: terms.attendees ?? 2, budgetTotalCents: budget, needs: { terms, baseline: null, noObstructed: false, togetherRequired: false }, accessibilityRequired: false, timeZone: 'America/New_York', observedAt: new Date('2026-09-30') }) };
}

describe('R9: supplied concert decisions stay on the requested experience', () => {
  for (const turn of [1, 2]) it(`different-room admission cannot beat Kiefer admission, turn ${turn}`, () => {
    const r = compare('19', turn, 10000);
    expect(r.lead).toMatch(/^Offer A.*\$60/);
    expect(r.lead).not.toMatch(/less than.*B/);
    expect(r.items[1]).toMatch(/different (?:event|performance)|requested performance/);
    expect(r.offers[1]!.quantity).not.toBe(1);
  });
  for (const id of ['12', '23']) it(`${id}: artist goal applies to each offer; an explicit DJ goal replaces it`, () => {
    expect(compare(id, 1, 20000).lead).toMatch(/^Offer B.*\$180/);
    const changed = compare(id, 2, 8000);
    expect(changed.lead).toMatch(/^Offer A.*\$60/);
    expect(changed.lead).toContain('$20');
  });
  it('latest named-artist appearance replaces the old absence, conditionally', () => {
    expect(concertQuestion(messages('20', 1))?.lead).toContain('Skip it');
    expect(concertQuestion(messages('20', 2))?.lead).toContain('original artist will perform');
    expect(concertQuestion(messages('20', 2))?.items.join(' ')).toContain('haven’t independently verified');
  });
  it('a DJ appearing at the party does not establish an appearance by the requested artist', () => {
    expect(concertQuestion([...messages('20', 1), 'The same Dua Lipa dance party description is updated: the DJ WILL appear and perform a live set. Does this meet our original artist goal?'])?.lead).toContain('Skip it');
  });
  it('a single ticketless upgrade gets a direct answer', () => {
    expect(concertQuestion(messages('18'))?.lead).toMatch(/(?:No|won.t).*admission|cannot get.*concert/i);
    expect(admissionTerms(messages('17')[0]!.split('Offer B')[0]!).admission).toBe('excluded');
  });
});

describe('R9: revisions preserve party, quantity, fees and unchanged offers', () => {
  for (const turn of [1, 2]) it(`one admission per package is not one package available, turn ${turn}`, () => {
    const r = compare('22', turn, 25000);
    expect(r.lead).toMatch(/^Offer A.*\$180/);
    expect(r.lead).toContain('$20 less');
    expect(r.offers[0]!.quantity).toBe(2);
  });
  it('B’s price-only correction replaces each with a total', () => {
    const r = compare('10', 2, 10000);
    expect(r.lead).toMatch(/^Offer B.*\$90/);
    expect(r.lead).toContain('$10');
    expect(offerTotal(r.offers.find((o) => o.label === 'B')!, 3)?.cents).toBe(9000);
    expect(r.offers.find((o) => o.label === 'A')!.admission).toBe('excluded');
  });
  it('global including-fees declaration binds all prices, and C’s correction retains the rest', () => {
    expect(compare('11', 1, 35000).lead).toMatch(/^Offer C.*\$280/);
    const changed = compare('11', 2, 35000);
    expect(changed.lead).toMatch(/^Offer B.*\$320/);
    expect(changed.offers[2]).toMatchObject({ admission: 'included', productKind: 'admission', feeBasis: 'all_in' });
    expect(changed.items[2]).toContain('Over your $350 budget by $50');
    const mixed = offersInText('Concert quotes including fees: Offer A concert admission $100 each. Offer B concert admission $90 each BEFORE fees.');
    expect(mixed.map((o) => o.feeBasis)).toEqual(['all_in', 'before_fees']);
  });
  it('plain party statements cannot become room names or source-price budgets', () => {
    expect(partyTerms(messages('19', 3)).attendees).toBe(2);
    expect(partyTerms(['Two adults and three children need concert admission.']).attendees).toBe(5);
  });
  it('package stock is not inferred from a $90 unit price', () => {
    const a = compare('08', 3, 25000).offers[0]!;
    expect(a.unitsAvailable).toBeNull();
    expect(a.quantity).toBeNull();
    expect(a.admissionsPerUnit).toBe(1);
  });
  it('new unknown entitlement clears the old per-package admission claim', () => {
    const r = compare('08', 2, 25000);
    expect(r.offers[0]).toMatchObject({ admission: 'unknown', admissionsPerUnit: null, quantity: null });
    expect(r.items[0]).not.toContain('one admission per package');
  });
  it('two admissions per package requires only one package for a party of two', () => {
    const [a] = offersInText('Concert quotes: Offer A: two VIP packages available, $90 each all-in, each package includes two concert admissions. Offer B: two concert admissions, $200 total all-in.');
    expect(a).toMatchObject({ unitsAvailable: 2, admissionsPerUnit: 2, quantity: 4 });
    expect(offerTotal(a!, 2)).toMatchObject({ cents: 9000, tickets: 2 });
  });
  it('a quoted source price never becomes a cap; familiar explicit cap phrases still work', () => {
    expect(concertBudget(messages('19', 3).at(-1)!)).toBeNull();
    expect(concertBudget('Two adults, under $200 total for the concert.')).toEqual({ cents: 20000, basis: 'whole_party' });
    expect(concertBudget('Two tickets, $80 each max with fees.')).toEqual({ cents: 8000, basis: 'per_ticket' });
    expect(concertBudget('Same Chicago concert, three people, $300 TOTAL with fees.')).toEqual({ cents: 30000, basis: 'whole_party' });
  });
  it('an explicit fresh search abandons old offers and does not resurrect them on a later single quote', () => {
    const ms = [...messages('11'), 'Forget those offers. Start over: find other electronic concerts in Austin.', 'Offer A: concert admission $30 total all-in.'];
    expect(suppliedOffers(ms[3]!, ms.slice(0, 4), 'America/Chicago').textOffers).toEqual([]);
    expect(suppliedOffers(ms[4]!, ms, 'America/Chicago').textOffers).toEqual([]);
  });
  it('one adult sitting with each child is a seating rule, not a new party of one', () => {
    expect(partyTerms(['Four of us are going to a show.', 'One adult must sit beside each child.']).attendees).toBe(4);
  });
});

describe('R9: venue-local overnight boundaries', () => {
  for (const [turn, winner, total] of [[1, 'B', 80], [2, 'A', 50], [3, 'A', 50]] as const) it(`14 turn ${turn}: ${winner} $${total}`, () => {
    expect(compare('14', turn, 9000).lead).toMatch(new RegExp(`^Offer ${winner}.*\\$${total}`));
  });
  it('a missing arrival date is not inferred; a later date-only answer completes it', () => {
    expect(nightTiming(messages('16', 1))?.arrivalDate).toBeNull();
    expect(compare('16', 1, 9000).items[0]).toContain('calendar date');
    expect(compare('16', 2, 9000).lead).toMatch(/^Offer B.*\$80/);
  });
  it('UNTIL allows an earlier arrival; BEFORE is strict and an unspecified boundary needs confirmation', () => {
    const timing = nightTiming(messages('14', 3))!;
    expect(entryFailure(entryTerm('admission valid UNTIL 2am Saturday Oct 3, 2026'), { ...timing, arrival: 119 })).toBeNull();
    expect(entryFailure(entryTerm('admission valid UNTIL 2am Saturday Oct 3, 2026'), { ...timing, arrival: 120 })).toContain('not confirmed');
    expect(entryFailure(entryTerm('entry BEFORE 2am Saturday Oct 3, 2026'), { ...timing, arrival: 120 })).toContain('cutoff');
    expect(entryFailure(entryTerm('admission valid UNTIL 2am Saturday Oct 3, 2026'), { ...timing, arrival: 121 })).toContain('cutoff');
  });
  it('an arrival correction cannot become a new show start', () => {
    expect(nightTiming([...messages('14', 1), 'Same event; we arrive at 1am Saturday Oct 3.'])?.start).toBe(1380);
  });
  it('a dated cutoff correction inherits the event year, not an assumed next-day cutoff', () => {
    const ms = [...messages('14', 1), "A's revised entry condition says admission valid UNTIL 2am Sunday Oct 4. B is unchanged. We arrive at 1am Sunday Oct 4."];
    const { textOffers } = suppliedOffers(ms.at(-1)!, ms, 'America/New_York');
    expect(textOffers[0]!.entry).toMatchObject({ date: '2026-10-04' });
    expect(entryFailure(textOffers[0]!.entry, nightTiming(ms))).toBeNull();
  });
  it('invalid copied dates and cutoff times stay unknown without crashing', () => {
    expect(entryTerm('entry before 25:99pm')).toEqual({ kind: 'unknown' });
    expect(nightTiming(['The event starts Oct 32, 2026 at 11pm. We arrive Oct 33 at 1am.'])?.eventDate).toBeNull();
  });
});

describe('R9: quoted admission policies are conditional, with independent ID and guardian checks', () => {
  it('guardian requirement excludes an unaccompanied 16-year-old', () => expect(concertQuestion(messages('13', 1))?.lead).toContain('cannot attend unaccompanied'));
  it('government-ID requirement is not satisfied by school ID', () => expect(concertQuestion(messages('13', 2))?.lead).toMatch(/(?:cannot|do not|don’t|doesn’t).*ID|ID.*(?:does not|doesn’t|not meet)/));
  it('an ID-only correction preserves ages, guardian permission and ID held', () => expect(concertQuestion(messages('13', 3))?.lead).toMatch(/meet.*supplied|meet.*requirements/));
  it('under-16 guardian requirement does not apply to 16-year-olds with accepted ID', () => expect(concertQuestion(messages('21'))?.lead).toMatch(/meet.*supplied|meet.*requirements/));
  it('age eligibility alone does not claim their unknown ID qualifies', () => {
    const r = concertQuestion(['Two 16-year-olds without adults want a pop gig. Event policy says minimum age 16; 16-year-olds may enter unaccompanied; government-issued photo ID required. Can they enter?']);
    expect(r?.lead).toContain('ID still needs confirming');
    expect(r?.lead).not.toContain('both meet');
  });
  it('an explicit prohibition on unaccompanied entry cannot become permission', () => {
    const r = concertQuestion(['Two 16-year-olds without adults want a pop gig. The event policy says minimum age 16; 16-year-olds may NOT enter unaccompanied; school photo ID accepted. Both have school photo IDs. Can they enter?']);
    expect(r?.lead).toContain('cannot attend unaccompanied');
  });
});
