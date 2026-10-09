import { describe, expect, it } from 'vitest';
import { correctToKnown, editDistance } from '@/lib/domain/name-correction';

const known = [
  { name: 'Notre Dame Fighting Irish', aliases: ['Notre Dame'] },
  { name: 'New York Knicks', aliases: [] },
  { name: 'Brooklyn Nets', aliases: [] },
  { name: 'Metallica', aliases: [] },
];

describe('a typo in a name we know is read as that name', () => {
  it.each([
    ['Norte Dane', 'Notre Dame Fighting Irish'],
    ['Kincks', 'New York Knicks'],
    ['Metalica', 'Metallica'],
  ])('%s → %s', (typed, to) => expect(correctToKnown(typed, known)).toEqual({ from: typed, to }));

  it('a name we know as typed, or a short one, is left alone', () => {
    expect(correctToKnown('Notre Dame', known)).toBeNull();
    expect(correctToKnown('Knicks', known)).toBeNull();
    // "Jets" is a different team, not a typo of "Nets".
    expect(correctToKnown('Jets', known)).toBeNull();
    expect(correctToKnown('Taylor Swift', known)).toBeNull();
  });

  it('counts a swapped pair of letters as one slip', () => {
    expect(editDistance('kincks', 'knicks')).toBe(1);
    expect(editDistance('norte dane', 'notre dame')).toBe(2);
  });
});
