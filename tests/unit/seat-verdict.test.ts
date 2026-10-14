import { describe, expect, it } from 'vitest';
import { GOOD_SEATS_ASKED, sectionAndRow, seatVerdict } from '@/lib/advice/seat-verdict';

/** #149: "Are these good seats? Section 224 row G" restated the listing and never said whether 224 row G is good. */
describe('seat verdict', () => {
  it.each(['Are these good seats?', 'found these r they any good??', 'is this ok? sec 224', 'how good are the seats'])('"%s" asks about the seats', (s) => expect(GOOD_SEATS_ASKED.test(s)).toBe(true));
  it.each(['Can you check these?', 'good morning', 'any tickets left?'])('"%s" does not', (s) => expect(GOOD_SEATS_ASKED.test(s)).toBe(false));

  it('reads the section and row', () => {
    expect(sectionAndRow('sec 224 row g')).toEqual({ section: '224', row: 'G' });
    expect(sectionAndRow('Section 105, row 12, 2 tickets')).toEqual({ section: '105', row: '12' });
    expect(sectionAndRow('2 tickets please')).toBeNull();
  });

  const base = { section: '224', row: 'G', zone: 'upper', quantity: 2, theirTotalCents: 26000, venueName: 'Madison Square Garden' };
  it('opens on a verdict: the level, the row, and the price against the other levels', () => {
    const v = seatVerdict({ ...base, others: [{ zone: 'lower', section: '105', totalCents: 54000 }, { zone: 'upper', section: '225', totalCents: 31000 }] })!;
    expect(v).toMatch(/^Good value, but not great seats: Section 224, row G \(the seventh row of that section\) is in the upper level at Madison Square Garden\./);
    expect(v).toContain('nothing in the upper level I checked is cheaper');
    expect(v).toContain('The lower bowl starts at $540 for two (section 105), $280 more.');
  });

  it('names a cheaper set in the same level', () => {
    expect(seatVerdict({ ...base, others: [{ zone: 'upper', section: '227', totalCents: 20000 }] })).toMatch(/^Not great seats, and not the cheapest of their kind:.*section 227 for \$200 for two, against \$260/);
  });

  it('says nothing about a section the venue zones don’t place', () => {
    expect(seatVerdict({ ...base, zone: null, others: [] })).toBeNull();
  });
});
