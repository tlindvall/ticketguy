import { describe, expect, it } from 'vitest';
import { areaFor, categoryBuyingNote, collapseRuns, genreFamilyFor, genreMatches, narrowByFor, oneListingPerShow, pilotCategoriesFor } from '@/lib/domain/browse';
import { genreFor, subtypeFor } from '@/lib/catalog/sync';
import { isLocalTeam, mergeExtraction } from '@/lib/intake/pipeline';
import { marketById } from '@/lib/domain/markets';
import { RequestExtractionSchema } from '@/lib/domain/types';
import { FixtureExtractor } from '@/lib/ai/extraction';
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

  it('covers everything the provider lists unless blocked, and names the right thing to narrow by', () => {
    // Everything is covered unless blocked: soccer and college games are sports, cinema stays out.
    expect(pilotCategoriesFor('soccer', ['cinema'])).toEqual(['soccer']);
    expect(pilotCategoriesFor('sports', ['cinema'])).toContain('ncaa_regular');
    expect(pilotCategoriesFor(null, ['cinema', 'conventions'])).not.toContain('cinema');
    expect(pilotCategoriesFor(null, ['cinema'])).toContain('family');
    expect(narrowByFor('nfl').askFor).toBe('a team');
    expect(narrowByFor('concert').narrowBy).toBe('an artist, venue or kind of music');
  });
});

describe('kind of music and borough', () => {
  it('reads the customer\'s words for music as a family the provider genres match', () => {
    const rock = genreFamilyFor('I like indie rock and roll')!;
    expect(rock.key).toBe('rock');
    expect(genreMatches(rock, 'alternative / alternative rock')).toBe(true);
    expect(genreMatches(rock, 'jazz')).toBe(false);
    expect(genreMatches(rock, null)).toBe(false);
    expect(genreMatches(rock, 'pop / pop rock')).toBe(false); // Charlie Puth is pop
    expect(genreMatches(rock, 'hip-hop/rap / rock')).toBe(false);
    expect(genreMatches(rock, 'other / punk')).toBe(true);
    expect(genreFamilyFor('jazz')!.label).toBe('Jazz');
    expect(genreFamilyFor('something fun')).toBeNull();
  });

  it('stores the provider genre, falling back to the performer and ignoring "Undefined"', () => {
    expect(genreFor({ genre: 'Rock', subGenre: 'Indie Rock', attractions: [] })).toBe('rock / indie rock');
    expect(genreFor({ genre: 'Undefined', subGenre: null, attractions: [{ providerId: 'a', name: 'x', url: null, segment: 'Music', genre: 'Jazz', subGenre: 'Undefined' }] })).toBe('jazz');
    expect(genreFor({ genre: null, subGenre: null, attractions: [] })).toBeNull();
    // A venue that files every night as Rock does not make a hip-hop headliner rock.
    expect(genreFor({ genre: 'Rock', subGenre: 'Rock', attractions: [{ providerId: 'j', name: 'Jeru The Damaja', url: null, segment: 'Music', genre: 'Hip-Hop/Rap', subGenre: 'Hip-Hop/Rap' }] })).toBe('hip-hop/rap');
  });

  it('knows the boroughs and treats New York as the whole market', () => {
    expect(areaFor('Brooklyn')!.label).toBe('Brooklyn');
    expect(areaFor('we are staying in brooklyn')!.venueCities).toEqual(['brooklyn']);
    expect(areaFor('New York')).toBeNull();
    expect(areaFor(null)).toBeNull();
  });
});

describe('NFL listings that are not a ticket to the game', () => {
  it('files seat licences, season plans and tailgates as packages', () => {
    for (const name of ['New York Jets PSL', 'Giants Personal Seat License', 'Jets Season Tickets 2027', 'Giants Tailgate Party']) expect(subtypeFor({ name, timeTba: false }), name).toBe('package');
    expect(subtypeFor({ name: 'New York Giants vs. Philadelphia Eagles', timeTba: false })).toBeNull();
  });
});

describe('a shared nickname means the local team, wherever the customer is', () => {
  const away = [{ e: { isHome: false }, v: { city: 'San Francisco' } }];
  const ny = marketById('new-york');
  const la = marketById('los-angeles');
  it('is the team named for the market, or at home in one of its venues', () => {
    expect(isLocalTeam({ name: 'New York Giants' }, [], ny)).toBe(true);
    expect(isLocalTeam({ name: 'San Francisco Giants' }, away, ny)).toBe(false);
    expect(isLocalTeam({ name: 'San Francisco Giants' }, [], marketById('bay-area'))).toBe(true);
    expect(isLocalTeam({ name: 'Brooklyn Nets' }, [], ny)).toBe(true);
    expect(isLocalTeam({ name: 'Anaheim Ducks' }, [{ e: { isHome: true }, v: { city: 'Elmont' } }], ny)).toBe(true);
    // In LA, the LA Kings are the Kings; in New York, neither Kings is local, so "Kings" is still asked.
    expect(isLocalTeam({ name: 'Los Angeles Kings' }, away, la)).toBe(true);
    expect(isLocalTeam({ name: 'Los Angeles Kings' }, away, ny)).toBe(false);
    expect(isLocalTeam({ name: 'Sacramento Kings' }, away, ny)).toBe(false);
  });
});

describe('"the other 7" is more of the list, not seven tickets', () => {
  it('reads as wantsMore with no quantity, and does not carry into the next message', async () => {
    const x = new FixtureExtractor();
    const base = { messageId: 'm', subject: null, receivedAt: new Date('2026-09-28T12:00:00Z'), venueTimeZone: 'America/New_York', knownEntities: [] };
    const more = await x.extract({ ...base, text: 'can you give me the other 7' });
    expect(more.wantsMore).toBe(true);
    expect(more.quantity).toBeNull();
    const next = await x.extract({ ...base, text: 'Pennywise please' });
    expect(mergeExtraction(RequestExtractionSchema.parse(more), next).wantsMore).toBeNull();
  });
});

describe('runs and category advice', () => {
  it('folds a run of dates at one venue into its first date, and keeps different shows apart', () => {
    const rows = [
      { name: 'Hamilton', venueId: 'rr', day: '2026-10-06' },
      { name: 'Wicked', venueId: 'gw', day: '2026-10-06' },
      { name: 'Hamilton', venueId: 'rr', day: '2026-10-07' },
      { name: 'Hamilton', venueId: 'rr', day: '2026-10-10' },
      { name: 'Hamilton', venueId: 'other', day: '2026-10-08' }, // a touring company elsewhere is a different pick
    ];
    const out = collapseRuns(rows, (r) => r);
    expect(out.map((r) => [r.item.name, r.item.venueId, r.moreDates, r.lastDay])).toEqual([['Hamilton', 'rr', 2, '2026-10-10'], ['Wicked', 'gw', 0, null], ['Hamilton', 'other', 0, null]]);
  });

  it('says the thing each kind of event needs said before buying', () => {
    expect(categoryBuyingNote('comedy')).toContain('drink or food minimum');
    expect(categoryBuyingNote('broadway')).toContain('TodayTix and the TKTS booth');
    expect(categoryBuyingNote('nba')).toBeNull();
  });
});
