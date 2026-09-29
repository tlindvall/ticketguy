import { describe, expect, it } from 'vitest';
import { headerFirstName, statedFirstName } from '@/lib/domain/names';

describe('first names for greetings', () => {
  it('takes the name the customer gives', () => {
    expect(statedFirstName("Hey hey, Tobias here. I'm looking to get 5 tickets")).toBe('Tobias');
    expect(statedFirstName('Hi, my name is Priya and I need two seats')).toBe('Priya');
    expect(statedFirstName("Hello! This is Marcus. Any Knicks games?")).toBe('Marcus');
    expect(statedFirstName("Hi, I'm Dana, two tickets please")).toBe('Dana');
  });

  it('never mistakes an ordinary word for a name', () => {
    expect(statedFirstName("I'm looking to get 5 tickets")).toBeNull();
    expect(statedFirstName('still here, any update?')).toBeNull();
    expect(statedFirstName('Hey here is the link')).toBeNull();
    expect(statedFirstName("I'm in New York next week")).toBeNull();
  });

  it('falls back to the account name, but not to a role or an address', () => {
    expect(headerFirstName('Tobias Lindvall')).toBe('Tobias');
    expect(headerFirstName('"Priya Patel"')).toBe('Priya');
    expect(headerFirstName('Ticket Sales')).toBeNull();
    expect(headerFirstName('info@example.com')).toBeNull();
    expect(headerFirstName(null)).toBeNull();
  });
});
