import { describe, expect, it } from 'vitest';
import { homeByVotes, homeFromStatement, marketOfVenue } from '@/lib/domain/home-market';
import { findResidenceStatement } from '@/lib/domain/country';
import { marketById } from '@/lib/domain/markets';

describe('where a customer says they live', () => {
  it.each([
    ['I live in Dallas', 'dallas'],
    ["we're based in the Bay Area", 'bay-area'],
    ["I'm in Brooklyn and want two tickets", 'new-york'],
    ['I live in New York', 'new-york'],
    ['we live in Bushwick', 'new-york'],
    ["I'm based out of Chicago, so nothing too far", 'chicago'],
    ['I am from Philly', 'philadelphia'],
  ])('%s → %s', (said, id) => {
    expect(homeFromStatement(said)?.id).toBe(id);
  });

  it.each([
    "I'm in a hurry",
    "I'm in need of tickets",
    "I'm in for 2 tickets to the Bay Area show",
    'I live in Texas',
    "I'm not in New York",
    'I live in London',
    null,
  ])('%s says nothing we can use', (said) => {
    expect(homeFromStatement(said)).toBeNull();
  });

  it('a metro we serve is a US residence, and a trip is not', () => {
    expect(findResidenceStatement('I live in Dallas. Two Rangers tickets please')).toBe('I live in Dallas');
    expect(findResidenceStatement("I'm in Vegas for the weekend, any shows?")).toBeNull();
  });
});

describe('where most of their requests were', () => {
  const ny = marketById('new-york');
  const vegas = marketById('las-vegas');
  it('one trip does not move a New Yorker', () => {
    expect(homeByVotes([vegas, ny, ny])?.id).toBe('new-york');
  });
  it('a tie goes to the latest', () => {
    expect(homeByVotes([vegas, ny])?.id).toBe('las-vegas');
  });
  it('nothing known is null', () => {
    expect(homeByVotes([null, null])).toBeNull();
  });
  it('a venue is in its metro, or its own town', () => {
    expect(marketOfVenue({ city: 'Arlington', state: 'TX', country: 'US' })?.id).toBe('dallas');
    expect(marketOfVenue({ city: 'Boise', state: 'ID', country: 'US' })?.id).toBe('city:boise,id');
    expect(marketOfVenue({ city: 'Toronto', country: 'CA' })).toBeNull();
  });
});
