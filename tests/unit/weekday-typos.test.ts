import { describe, expect, it } from 'vitest';
import { resolveRelativeDate, spellWeekdays } from '@/lib/domain/dates';
import { readDate } from '@/lib/ai/extraction';

/** #150: "Can you find me 5 tickts to the Rangres this thrusday?" asked "Thu or Sat?" instead of reading Thursday. */
describe('misspelled weekdays', () => {
  it.each([
    ['this thrusday', 'this thursday'],
    ['Thrusday night', 'Thursday night'],
    ['firday', 'friday'],
    ['next wensday', 'next wednesday'],
    ['saterdays', 'saturdays'],
    ['fridy', 'friday'],
    ['tusday', 'tuesday'],
  ])('%s → %s', (typo, right) => expect(spellWeekdays(typo)).toBe(right));

  it.each(['today', 'tonight', 'birthday', 'holiday', 'midday', 'someday', 'weekday', 'funday', 'ice cream sundae', 'thursday', 'Sunday'])('leaves "%s" alone', (w) => expect(spellWeekdays(w)).toBe(w));

  it('resolves "this thrusday" to the coming Thursday', () => {
    const mon = new Date('2026-10-19T15:00:00Z'); // Mon Oct 19 2026
    expect(resolveRelativeDate('this thrusday', mon, 'America/New_York')).toMatchObject({ kind: 'resolved', localDate: '2026-10-22' });
    expect(readDate('5 tickets to the Rangers this thrusday?', mon, 'America/New_York').resolvedLocalDate).toBe('2026-10-22');
  });
});
