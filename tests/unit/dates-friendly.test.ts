import { describe, expect, it } from 'vitest';
import { dateWindowFor, friendlyDay, friendlyWhen } from '@/lib/domain/dates';

describe('dates as a person says them', () => {
  const now = new Date('2026-10-03T16:00:00Z'); // Saturday noon in New York
  const tz = 'America/New_York';
  it('tonight, tomorrow, and a day with its date', () => {
    expect(friendlyWhen(new Date('2026-10-03T23:00:00Z'), tz, now)).toBe('tonight at 7 p.m.');
    expect(friendlyWhen(new Date('2026-10-04T22:00:00Z'), tz, now)).toBe('tomorrow, Sunday, October 4, at 6 p.m.');
    expect(friendlyWhen(new Date('2026-10-13T23:15:00Z'), tz, now)).toBe('Tuesday, October 13, at 7:15 p.m.');
    expect(friendlyDay('2026-10-13')).toBe('Tuesday, October 13');
  });
  it('"N weeks from now" is the fortnight around that day', () => {
    expect(dateWindowFor('about six weeks from now', now, tz)).toEqual({ from: '2026-11-07', to: '2026-11-21' });
    expect(dateWindowFor('in 3 weeks', now, tz)).toEqual({ from: '2026-10-17', to: '2026-10-31' });
    expect(dateWindowFor('a month from now', now, tz)).toEqual({ from: '2026-10-26', to: '2026-11-09' });
  });
});
