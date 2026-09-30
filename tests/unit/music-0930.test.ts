import { describe, expect, it } from 'vitest';
import cases from '../fixtures/qa-music-0930.json';
import { offerTotal, partyTerms } from '@/lib/advice/text-offers';
import { suppliedOffers } from '@/lib/intake/pipeline';
import { suppliedOffersAnswer } from '@/lib/advice/packet';
import { admissionTerms, copiedAdmissionPolicy, concertQuestion, entryFailure, entryTerm, nightTiming, similarMusicGoal } from '@/lib/advice/concert-terms';
const messages = (id: string) => cases.find((c) => c.id === id)!.messages;
const answer = (ms: string[], budget = 25000) => {
  const { textOffers } = suppliedOffers(ms.at(-1)!, ms, 'America/New_York');
  return { textOffers, ...suppliedOffersAnswer({ offers: textOffers, quantity: 2, budgetTotalCents: budget, needs: { noObstructed: false, togetherRequired: false, baseline: null, terms: partyTerms(ms) }, accessibilityRequired: false, timeZone: 'America/New_York', observedAt: new Date('2026-09-30') }) };
};
describe('concert entitlement and copied terms', () => {
  for (const [id, total, budget] of [['16', 22000, 25000], ['19', 17000, 20000]] as const) {
    messages(id).forEach((_, i) => it(`${id} exact customer turn ${i + 1}`, () => {
      const r = answer(messages(id).slice(0, i + 1), budget);
      expect(r.textOffers.find((o) => o.label === 'A')?.admission).toBe('excluded');
      expect(offerTotal(r.textOffers.find((o) => o.label === 'B')!, 2)?.cents).toBe(total);
      expect(r.lead).toMatch(/^Offer B/);
      expect(r.lead).not.toMatch(/A only beats/);
      expect(r.items.join(' ')).toContain('excluded from the admission comparison');
      expect(r.items.join(' ')).not.toContain('ordinary seats');
    }));
  }
  it('festival: shuttle excluded; B costs $320, C exceeds $350', () => {
    const r = answer(messages('17'), 35000);
    expect(r.lead).toMatch(/^Offer B.*\$320/);
    expect(r.textOffers[0]!.admission).toBe('excluded');
    expect(r.items[2]).toContain('Over your $350 budget');
  });
  it('packages including admission remain eligible; unknown packages cannot win', () => {
    const r = answer(['Concert tickets: Offer A: VIP package includes concert admission, $90 each all-in. Offer B: concert admission, $110 each all-in.']);
    expect(r.lead).toMatch(/^Offer A/);
    const unknown = answer(['Concert tickets: Offer A: VIP package, admission not specified, $30 each all-in. Offer B: concert admission, $110 each all-in.']);
    expect(unknown.lead).toMatch(/^Offer B/);
    expect(unknown.items[0]).toContain('entitlement is unknown');
  });
  it('a price-only restatement retains exclusion; an explicit replacement changes entitlement', () => {
    const first = messages('19')[1]!;
    expect(answer([first, 'Offer A: $45 total. Offer B: $170 total.']).textOffers[0]!.admission).toBe('excluded');
    expect(answer([first, 'Offer A is now two concert admission tickets for $150 total all-in. Offer B is two concert admissions for $170 total all-in.']).lead).toMatch(/^Offer A/);
  });
  it('new explicit per-ticket basis overrides an old total with the same number', () => {
    const r = answer(['Offer A: concert admission $100 total. Offer B: concert admission $150 total.', 'Offer A: concert admission $100 each all-in. Offer B: concert admission $150 total.']);
    expect(offerTotal(r.textOffers[0]!, 2)?.cents).toBe(20000);
  });
  it('paraphrased extras and affirmative bundles', () => {
    expect(admissionTerms('Shuttle-only pass; separate event ticket required').admission).toBe('excluded');
    expect(admissionTerms('VIP package with concert admission and parking').admission).toBe('included');
    expect(admissionTerms('VIP package may include admission').admission).toBe('unknown');
  });
});
describe('music questions', () => {
  for (let i = 0; i < 2; i++) it(`artist absent exact turn ${i + 1}`, () => expect(concertQuestion(messages('18').slice(0, i + 1))?.lead).toMatch(/^Skip it/));
  it('changed experience is honored', () => expect(concertQuestion([...messages('18'), 'I now just want to dance at the DJ party. Should I buy it?'])?.lead).toMatch(/^For your new goal/));
  it('similar pop is a new discovery goal', () => expect(similarMusicGoal(messages('02')[1]!)).toBe(true));
  for (let i = 0; i < 2; i++) it(`unaccompanied minors exact turn ${i + 1}`, () => expect(concertQuestion(messages('09').slice(0, i + 1))?.lead).toContain('haven’t verified any event-specific policy'));
  it('adult-accompanied controls are not intercepted', () => expect(concertQuestion(['I am going with my 16-year-old to a concert.'])).toBeNull());
});
describe('overnight entry', () => {
  messages('15').forEach((_, i) => it(`exact turn ${i + 1}: B $80, not before-midnight A`, () => {
    const r = answer(messages('15').slice(0, i + 1), 9000);
    expect(r.lead).toMatch(/^Offer B.*\$80/);
    expect(r.items[0]).toContain('at or after the cutoff');
    expect(r.lead).toContain('$10');
  }));
  it('before the cutoff works; exactly midnight does not; doors stay separate', () => {
    const timing = nightTiming(['It starts Friday Oct 2, 2026 at 11pm. Doors at 10pm. We arrive Friday Oct 2 at 11:30pm.'])!;
    expect(timing).toMatchObject({ start: 1380, doors: 1320, arrival: 1410 });
    expect(entryFailure(entryTerm('entry before midnight'), timing)).toBeNull();
    expect(entryFailure(entryTerm('entry before 11pm'), timing)).toContain('at or after the cutoff');
    expect(entryFailure(entryTerm('entry before midnight'), { ...timing, arrivalDate: '2026-10-03', arrival: 0 })).toContain('at or after the cutoff');
    expect(entryFailure(entryTerm('entry before midnight'), { ...timing, arrivalDate: null })).toContain('calendar dates');
  });
});

describe('corrections and positive controls', () => {
  it('partial corrections preserve both products across more than one abbreviated turn', () => {
    const ms = [messages('19')[1]!, 'Offer A costs $40 total now.', 'Offer B costs $160 total now. Which offer gets us in?'];
    const r = answer(ms, 20000);
    expect(r.lead).toMatch(/^Offer B.*\$160/);
    expect(r.textOffers[0]).toMatchObject({ admission: 'excluded', totalCents: 4000, productKind: 'parking' });
  });
  it('explicit unknown entitlement replaces earlier included entitlement', () => {
    const r = answer(['Concert tickets. Offer A: VIP package includes concert admission, $100 total all-in. Offer B: concert admission $150 total all-in.', 'Offer A: VIP package, admission not specified, $100 total. Offer B: concert admission $150 total.']);
    expect(r.lead).toMatch(/^Offer B/);
    expect(r.textOffers[0]!.admission).toBe('unknown');
  });
  it('a correction explicitly confirming the original artist replaces an earlier absence', () => {
    expect(concertQuestion([...messages('18'), 'Correction: the original artist will perform at this party. Should I buy?'])?.lead).toContain('original artist will perform');
  });
  it('plain VIP upgrades remain unknown, and parking entry is not concert admission', () => {
    expect(admissionTerms('VIP upgrade, $50').admission).toBe('unknown');
    expect(admissionTerms('Parking pass, anytime entry').admission).toBe('excluded');
  });
  it('a new live performance is not rejected because an earlier party excluded the artist', () => {
    expect(concertQuestion([...messages('18'), 'A different concert with the artist performing live: should I buy tickets?'])).toBeNull();
  });
  it('an original artist performing a DJ set is not presumed absent', () => {
    expect(concertQuestion(['Dua Lipa herself will perform a DJ set. Should I buy tickets?'])).toBeNull();
  });
  it('a quote can establish conditional age/guardian facts without becoming verified policy', () => {
    const quote = 'The event policy says 16+, no guardian required, government-issued ID. Both 16-year-olds will go without an adult. Can they enter?';
    expect(copiedAdmissionPolicy(quote)).toMatchObject({ minimumAge: 16, guardianRequired: false, acceptedId: 'government-issued ID', provenance: 'customer_supplied' });
    expect(concertQuestion([quote])?.lead).toContain('their ages meet the minimum');
    expect(concertQuestion([quote])?.items.join(' ')).toContain('haven’t independently verified');
    const no = quote.replace('no guardian required', 'guardian required');
    expect(concertQuestion([no])?.lead).toContain('cannot attend unaccompanied');
  });
  it('an all-ages label does not silently become guardian permission', () => {
    const r = concertQuestion(['My two 16-year-olds will go without an adult. The event policy says all ages. Can they enter?']);
    expect(r?.lead).toContain('haven’t verified');
  });
  it('doors are not a substitute for the event start, and unknown cutoff stays unknown', () => {
    const timing = nightTiming(['Doors at 11pm Friday Oct 2, 2026. We arrive Saturday Oct 3 at 1am.']);
    expect(timing?.start).toBeNull();
    expect(entryFailure(entryTerm('entry before midnight'), timing)).toContain('calendar dates');
    expect(entryFailure(null, timing)).toContain('unknown');
  });
});
