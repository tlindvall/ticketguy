import { describe, expect, it } from 'vitest';
import { dayChoice } from '@/lib/intake/pipeline';

/** Live Oct 5: "the 19th. 2 tickets together please" after "Thu, Nov 19 or Sat, Nov 21?" got the same question back. */
describe('a listed date picked by its day', () => {
  const dates = ['2026-11-19', '2026-11-21'];
  it('reads the day the way people say it', () => {
    expect(dayChoice('the 19th. 2 tickets together please.', dates)).toBe(0);
    expect(dayChoice('21st works', dates)).toBe(1);
    expect(dayChoice('Nov 21 please', dates)).toBe(1);
    expect(dayChoice('November 19th', dates)).toBe(0);
    expect(dayChoice('11/21', dates)).toBe(1);
    expect(dayChoice('Thursday', dates)).toBe(0);
    expect(dayChoice("saturday's show", dates)).toBe(1);
    expect(dayChoice('the sat one', dates)).toBe(1);
  });
  it('never guesses: no day, a day that fits neither, or one that fits both', () => {
    expect(dayChoice('2 tickets together please', dates)).toBeNull();
    expect(dayChoice('the 20th', dates)).toBeNull();
    expect(dayChoice('Dec 19', dates)).toBeNull();
    expect(dayChoice('the 19th', ['2026-11-19', '2026-12-19'])).toBeNull();
    expect(dayChoice('watching the sunset', dates)).toBeNull();
    expect(dayChoice('I may need 2', dates)).toBeNull();
  });
});
