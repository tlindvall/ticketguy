import { describe, expect, it } from 'vitest';
import { classifyResidence, findResidenceStatement } from '@/lib/domain/country';

const residence = (text: string) => classifyResidence(findResidenceStatement(text));

describe('residence from the customer’s own words', () => {
  it('reads a stated US place as US, including the NYC places people name instead of a state', () => {
    expect(residence("Yes, I'm in the US.")).toBe('US');
    expect(residence("I'm in Brooklyn, two Knicks tickets please")).toBe('US');
    expect(residence('We live in New Jersey and want Devils tickets')).toBe('US');
    expect(residence("I'm based in Manhattan")).toBe('US');
    expect(residence("I'm from Texas")).toBe('US');
  });

  it('reads a named non-US place or an explicit "not in the US" as NON_US', () => {
    expect(residence("I'm based in the UK. Two Rangers tickets Oct 3, $300 total.")).toBe('NON_US');
    expect(residence("We're visiting from London next month")).toBe('NON_US');
    expect(residence("I'm not in the US")).toBe('NON_US');
    expect(residence("I'm outside the US")).toBe('NON_US');
    expect(residence("I'm from Canada")).toBe('NON_US');
  });

  it('never treats everyday phrases as a country — the bug that closed US requests as "US-only"', () => {
    for (const text of [
      "I'm in a hurry — two Rangers tickets Oct 3, $300 total.",
      "I'm in need of tickets for us",
      "I'm in the market for Knicks seats",
      "I'm in love with this team",
      'I am in charge of buying for the office',
      "We're in no rush",
    ]) {
      expect(findResidenceStatement(text), text).toBeNull();
    }
  });

  it('does not read a trip as residence', () => {
    expect(residence("I'm in New York for the weekend, any Rangers game?")).toBeNull();
    expect(residence("I'm visiting New York in October")).toBeNull();
    expect(residence("We're in NYC on vacation")).toBeNull();
  });

  it('classifies the model’s free-text statement conservatively', () => {
    expect(classifyResidence('I live in Queens')).toBe('US');
    expect(classifyResidence('from the UK')).toBe('NON_US');
    expect(classifyResidence('originally from London, living in Brooklyn')).toBe('US');
    expect(classifyResidence('in a hurry')).toBeNull();
    expect(classifyResidence('')).toBeNull();
    expect(classifyResidence(null)).toBeNull();
  });
});
