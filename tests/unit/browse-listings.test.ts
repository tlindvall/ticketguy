import { describe, expect, it } from 'vitest';
import { narrowByFor, oneListingPerShow, pilotCoverageLabel } from '@/lib/domain/browse';
import { lexiconCategory } from '@/lib/lexicon/lexicon';

const at = new Date('2026-10-08T23:08:00Z');
const row = (name: string, venueId = 'stadium', startAt = at, entityId: string | null = null) => ({ name, venueId, startAt, entityId });

describe('one listing per show', () => {
  it('folds premium and package versions of one game into the plain one, where the first stood', () => {
    const out = oneListingPerShow([row('Pinstripe Pass * Yankees Division Series Game 2'), row('Knicks v Wizards', 'msg'), row('Yankees Division Series Game 2 * Premium Seating *'), row('Yankees Division Series Game 2')], (r) => r);
    expect(out.map((r) => r.name)).toEqual(['Yankees Division Series Game 2', 'Knicks v Wizards']);
  });

  it('keeps different shows at the same venue and time, and the same name at another time', () => {
    const out = oneListingPerShow([row('Jack White', 'hall'), row('Phoebe Bridgers', 'hall'), row('Jack White', 'hall', new Date('2026-10-09T23:08:00Z'))], (r) => r);
    expect(out).toHaveLength(3);
  });

  it('treats two listings for the same performer at the same slot as one show', () => {
    const out = oneListingPerShow([row('Jack White: VIP Experience', 'hall', at, 'jw'), row('Jack White - The Tour', 'hall', at, 'jw')], (r) => r);
    expect(out).toHaveLength(1);
  });
});

describe('football and soccer are their own kinds of event', () => {
  it('never reads "a football game" as every sport', () => {
    expect(lexiconCategory('I want to see an american football game in or near new york')).toBe('nfl');
    expect(lexiconCategory('any NFL on sunday?')).toBe('nfl');
    expect(lexiconCategory('a soccer match next weekend')).toBe('soccer');
    expect(lexiconCategory('what games are on?')).toBe('sports');
  });

  it('names the pilot coverage and the right thing to narrow by', () => {
    expect(pilotCoverageLabel(['concert', 'nhl', 'nba', 'mlb'])).toBe('concerts and NHL, NBA and MLB games');
    expect(pilotCoverageLabel(['concert', 'nhl', 'nba', 'mlb', 'nfl'])).toBe('concerts and NHL, NBA, MLB and NFL games');
    expect(narrowByFor('nfl').askFor).toBe('a team');
    expect(narrowByFor('concert').narrowBy).toBe('an artist, venue or kind of music');
  });
});
