import { describe, expect, it } from 'vitest';
import { dateWindowFor, spanWindowFor } from '@/lib/domain/dates';

// Monday 28 September 2026, 2:36pm in New York.
const NOW = new Date('2026-09-28T18:36:00Z');
const NY = 'America/New_York';
const w = (e: string) => dateWindowFor(e, NOW, NY);

describe('date spans people actually write', () => {
  it('reads a week of a month, including the "on" slip from the first real email', () => {
    expect(w('the first week on october')).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(w('first week of October')).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(w('the second week of november')).toEqual({ from: '2026-11-08', to: '2026-11-14' });
    expect(w('last week of october')).toEqual({ from: '2026-10-25', to: '2026-10-31' });
  });

  it('keeps "the first week in October" to the week, not the whole month', () => {
    expect(w('the first week in october')).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(w('in october')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('reads early, mid and late in a month', () => {
    expect(w('early october')).toEqual({ from: '2026-10-01', to: '2026-10-10' });
    expect(w('mid-October')).toEqual({ from: '2026-10-11', to: '2026-10-20' });
    expect(w('end of october')).toEqual({ from: '2026-10-21', to: '2026-10-31' });
    expect(w('late february')).toEqual({ from: '2027-02-21', to: '2027-02-28' }); // a passed month is next year
  });

  it('reads day ranges both ways round and across a year end', () => {
    expect(w('oct 1-7')).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(w('October 1st to 7th')).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(w('3rd - 9th Oct')).toEqual({ from: '2026-10-03', to: '2026-10-09' });
    expect(w('dec 28 - jan 3')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
    expect(spanWindowFor('oct 7-1', NOW, NY)).toBeNull(); // backwards is not a range
  });

  it('reads the next few weeks and this or next month from today', () => {
    expect(w('the next few weeks')).toEqual({ from: '2026-09-28', to: '2026-10-19' });
    expect(w('next 2 weeks')).toEqual({ from: '2026-09-28', to: '2026-10-12' });
    expect(w('this month')).toEqual({ from: '2026-09-28', to: '2026-09-30' });
    expect(w('next month')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('leaves single dates and the existing week phrases alone', () => {
    expect(spanWindowFor('oct 3', NOW, NY)).toBeNull();
    expect(w('next week')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });
});
