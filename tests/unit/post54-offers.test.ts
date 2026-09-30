import { describe, expect, it } from 'vitest';
import { offersInText, offerTotal, statedFeeBasis } from '@/lib/advice/text-offers';
import { restrictionCodesFrom } from '@/lib/ai/listing-evidence';
import { NO_OBSTRUCTED, SEATS_NOT_ACCESSIBLE, comparedAgainst, exclusionsIn } from '@/lib/intake/pipeline';
import replay from '../fixtures/qa-post54-cases.json';

const body = (id: string) => replay.cases.find((c) => c.id === id)!.body;

/**
 * Post-#54 QA (BUGS_AND_FEATURE_FIXES.md): one record per offer the customer copied, with its own quantity,
 * split rule, view, access, fee basis and per-order fee, and totals worked out once. Exact inputs first, then
 * paraphrases and negative controls, so the parser isn't fitted to one wording.
 */
describe('offers in their words, one record each', () => {
  it('X02: four offers, each with its own quantity, view and split rule', () => {
    const o = offersInText(body('X02'));
    expect(o.map((x) => x.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(o.map((x) => offerTotal(x, 5)!.cents)).toEqual([65000, 58500, 42500, 48000]);
    expect(o.map((x) => x.obstructed)).toEqual([false, false, true, null]);
    expect(o[3]).toMatchObject({ quantity: 6, mustBuyAll: true });
    expect(o.every((x) => x.feeBasis === 'all_in' && x.deliveryStated)).toBe(true);
    expect(comparedAgainst(body('X02'), ['A', 'B', 'C', 'D'])).toBe('A');
    expect(NO_OBSTRUCTED.test(body('X02'))).toBe(true);
  });

  it('X01: a per-order fee is added once; "including every fee" is all-in; A $220, B $210', () => {
    const [a, b] = offersInText(body('X01'));
    expect(a).toMatchObject({ perTicketCents: 9000, orderFeeCents: 4000, feeBasis: 'before_fees', noOtherCharges: true });
    expect(offerTotal(a!, 2)).toEqual({ cents: 22000, allIn: true, tickets: 2 });
    expect(b).toMatchObject({ perTicketCents: 10500, feeBasis: 'all_in' });
    expect(offerTotal(b!, 2)).toEqual({ cents: 21000, allIn: true, tickets: 2 });
  });

  it('R05: A’s access and price stay with A; B’s section and row stay with B', () => {
    const [a, b] = offersInText(body('R05'));
    expect(a).toMatchObject({ label: 'A', accessible: true, perTicketCents: 8000, section: null, row: null });
    expect(b).toMatchObject({ label: 'B', accessible: false, perTicketCents: 10500, section: '211', row: '12', together: true });
  });

  it('R05-F1: "ignore Offer A" leaves one offer, which is not a comparison', () => {
    expect(offersInText(body('R05-F1'))).toEqual([]);
  });

  it('paraphrase: numbered listings, "+ $48 per order", a limited view, and a block that won’t split', () => {
    const t = 'Listing 1: three seats together, $72 each plus fees, + $48 per order, nothing else to pay, limited view. Listing 2: 4 tickets together for $300 total all-in, sold only as a block. We need three and can’t have a limited view.';
    const [one, two] = offersInText(t);
    expect(one).toMatchObject({ label: '1', quantity: 3, perTicketCents: 7200, orderFeeCents: 4800, obstructed: true });
    expect(offerTotal(one!, 3)).toEqual({ cents: 26400, allIn: true, tickets: 3 });
    expect(two).toMatchObject({ label: '2', quantity: 4, mustBuyAll: true, totalCents: 30000, feeBasis: 'all_in' });
    expect(NO_OBSTRUCTED.test(t)).toBe(true);
  });

  it('negative controls: a view they don’t mind, "cheaper than a ticket", and a negated wheelchair mention', () => {
    expect(NO_OBSTRUCTED.test('I don’t mind an obstructed view if it saves money.')).toBe(false);
    expect(NO_OBSTRUCTED.test('I do not mind a limited view.')).toBe(false);
    expect(comparedAgainst('Is it cheaper than a ticket at the box office?', ['A', 'B'])).toBeNull();
    const [a] = offersInText('Offer A: ordinary seats, not wheelchair spaces, $90 each. Offer B: $95 each.');
    expect(a!.accessible).toBe(false);
  });
});

describe('what they said stays said (R3-B02, R3-B08)', () => {
  it('R03: "$220 total including fees" is all-in by their account', () => {
    expect(statedFeeBasis(body('R03'), 22000)).toBe('all_in');
    expect(statedFeeBasis('It is $220 before fees for both.', 22000)).toBe('before_fees');
    expect(statedFeeBasis('It is $220 for both.', 22000)).toBeNull();
  });

  it('R05-F1: a negated wheelchair mention is not a restriction, in the listing read or in their words', () => {
    expect(restrictionCodesFrom(['Not a wheelchair or companion space'])).toEqual([]);
    expect(restrictionCodesFrom(['non-accessible seating'])).toEqual([]);
    expect(restrictionCodesFrom(['Wheelchair accessible'])).toEqual(['accessible_seating']);
    expect(SEATS_NOT_ACCESSIBLE.test(body('R05-F1'))).toBe(true);
    expect(SEATS_NOT_ACCESSIBLE.test('These are wheelchair spaces, $80 each.')).toBe(false);
    expect(SEATS_NOT_ACCESSIBLE.test('Neither of us needs wheelchair seating.')).toBe(false);
  });
});

describe('what they ruled out in discovery (R3-B07)', () => {
  it('A04: no kids’ events, tribute acts or pop', () => {
    expect(exclusionsIn(body('A04')).sort()).toEqual(['kids', 'pop', 'tribute']);
  });
  it('negative controls: pop-up venues and pop-punk are not "pop"; a plain request rules nothing out', () => {
    expect(exclusionsIn('No pop-up bars please, just techno.')).toEqual([]);
    expect(exclusionsIn('Not into pop-punk, but otherwise anything goes.')).toEqual([]);
    expect(exclusionsIn('Two tickets to a pop concert in Brooklyn.')).toEqual([]);
  });
});
