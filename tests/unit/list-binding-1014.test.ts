import { describe, expect, it } from 'vitest';
import { asksCheapestGame, namesSide, offeredChoice } from '@/lib/intake/pipeline';
import { dateWindowFor, weekOfWindow } from '@/lib/domain/dates';
import { compareOffers } from '@/lib/domain/comparison';
import { EV, worldOffers } from '../../evals/world';

const ny = { timezone: 'America/New_York' };
const la = { timezone: 'America/Los_Angeles' };
const game = (name: string, iso: string, v = ny) => ({ e: { name, localStartAt: new Date(iso) }, v });

/** Eval issues #135, #144: a reply to the games we offered picks among them before anything is searched again. */
describe('a reply to the games we offered', () => {
  const october = [
    game('New York Rangers vs. New York Islanders (preseason)', '2026-10-03T23:00:00Z'),
    game('New York Rangers vs. Fixture Opponent', '2026-10-15T23:00:00Z'),
    game('New York Rangers vs. Boston Bruins', '2026-10-22T23:00:00Z'),
  ];

  it('picks by the other side, by order, by day, and by "the earlier one"', () => {
    expect(offeredChoice('The Islanders game.', october, 'New York Islanders')).toBe(0);
    expect(offeredChoice('the bruins one', october)).toBe(2);
    expect(offeredChoice('The earlier one works.', october)).toBe(0);
    expect(offeredChoice('the later one', october.slice(0, 2))).toBe(1);
    expect(offeredChoice('Let’s do the one on the 15th.', october)).toBe(1);
    expect(offeredChoice('the second one', october)).toBe(1);
  });

  it('a weekday is the listed game’s weekday, never the coming one (the lakers one on tuesday)', () => {
    const one = [game('Los Angeles Lakers vs. Golden State Warriors', '2027-01-13T03:30:00Z', la)];
    expect(offeredChoice('the lakers one on tuesday', one, 'Los Angeles Lakers')).toBe(0);
    // One game offered: a plain yes is that game; a day it isn't on, or another team, is not.
    expect(offeredChoice('yes, 2 tickets', one)).toBe(0);
    expect(offeredChoice('the lakers one on wednesday', one, 'Los Angeles Lakers')).toBeNull();
    expect(offeredChoice('what about the kings game that week instead', one, 'Los Angeles Kings')).toBeNull();
  });

  it('never picks on nothing, on a side every game shares, or against a "not"', () => {
    expect(offeredChoice('2 tickets, under $500 total', october)).toBeNull();
    expect(offeredChoice('the rangers game', october, 'New York Rangers')).toBeNull();
    expect(offeredChoice('not the islanders one', october, 'New York Islanders')).toBeNull();
    expect(offeredChoice('the Nets game', october, 'Brooklyn Nets')).toBeNull();
  });
});

/** Eval issue #146: a team is a side of a game whether it plays at home or away. */
describe('a team named as either side', () => {
  it('matches the visiting side by nickname or full name, and nothing else', () => {
    expect(namesSide('New York Knicks vs. Boston Celtics', 'celtics')).toBe(true);
    expect(namesSide('New York Knicks vs. Boston Celtics', 'Boston Celtics')).toBe(true);
    expect(namesSide('New York Knicks vs. Brooklyn Nets', 'the nets')).toBe(true);
    expect(namesSide('New York Knicks vs. Brooklyn Nets', 'Boston Celtics')).toBe(false);
    expect(namesSide('New York Knicks vs. Charlotte Hornets', 'nets')).toBe(false);
  });
});

/** Eval issue #143: "the week of Jan 12" is that Monday-to-Sunday week, however it is written. */
describe('the week of a day', () => {
  const at = new Date('2027-01-04T18:00:00Z');
  it.each(['the week of Jan 12', 'week of jan 12th', 'the week of the 12th of january', 'la sports 1/12 week?', 'jan 12 week', 'the week of 1/12', 'week of 2027-01-12'])('%s is Jan 11 to 17', (said) => {
    expect(weekOfWindow(said, at)).toEqual({ from: '2027-01-11', to: '2027-01-17' });
    expect(dateWindowFor(said, at, 'America/Los_Angeles')).toEqual({ from: '2027-01-11', to: '2027-01-17' });
  });
  it('a day alone is still a day', () => {
    expect(weekOfWindow('jan 12', at)).toBeNull();
  });
});

/** Eval issue #145: leaving the choice of game to the price. */
describe('whichever is cheaper', () => {
  it.each(['yo need 2 tix to a rangers home game this week, whichever is cheapest', 'whichever is cheaper like i said', "whichever's cheaper", 'whichever is cheaper?? pls compare both and send the total'])('%s chooses on price', (said) => {
    expect(asksCheapestGame(said)).toBe(true);
  });
  it('a price word alone is not a choice of games', () => {
    expect(asksCheapestGame('2 cheap tickets for thursday')).toBe(false);
  });
});

/** Eval issue #142: a block marked not together is never the pick for a group while a together one fits. */
describe('seats together for a group', () => {
  const offers = worldOffers()[EV.rangersBruins]!.filter((o) => o.quantity === 5);
  const c = { quantity: 5, togetherRequired: null, budgetTotalCents: null, excludeObstructedView: true, requireAccessible: false, acceptableSections: null, eventStartAt: '2026-10-22T23:00:00Z' };

  it('the together block first, the cheaper split (section 310) after it', () => {
    const r = compareOffers(offers, c, EV.rangersBruins);
    expect(r.eligible[0]!.offer.section).toBe('211');
    expect(r.eligible[0]!.offer.seatsTogether).toBe(true);
    expect(r.eligible.at(-1)!.offer.section).toBe('310');
  });
  it('a split block still ranks on price when they said splitting up is fine', () => {
    const r = compareOffers(offers, { ...c, togetherRequired: false }, EV.rangersBruins);
    expect(r.eligible[0]!.offer.section).toBe('310');
  });
});
