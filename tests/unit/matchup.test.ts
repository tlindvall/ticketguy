import { describe, expect, it } from 'vitest';
import { isAgainst, opponentFor, splitMatchup } from '@/lib/domain/matchup';

describe('matchups', () => {
  it('splits the ways customers write a game', () => {
    expect(splitMatchup('New York Rangers vs Tampa Bay Lightning')).toEqual({ first: 'New York Rangers', second: 'Tampa Bay Lightning' });
    expect(splitMatchup('Knicks v. Celtics')).toEqual({ first: 'Knicks', second: 'Celtics' });
    expect(splitMatchup('Islanders @ Rangers')).toEqual({ first: 'Islanders', second: 'Rangers' });
    expect(splitMatchup('Rangers versus Devils (preseason)')).toEqual({ first: 'Rangers', second: 'Devils' });
  });

  it('drops qualifiers written out after the opponent (eval Oct 13: "preseason game" emptied the opponent filter)', () => {
    expect(splitMatchup('New York Rangers vs New York Islanders preseason game')).toEqual({ first: 'New York Rangers', second: 'New York Islanders' });
    expect(splitMatchup('Knicks vs Celtics game 3')).toEqual({ first: 'Knicks', second: 'Celtics' });
    expect(splitMatchup('Rangers vs Devils home opener tonight')).toEqual({ first: 'Rangers', second: 'Devils' });
    expect(splitMatchup('Rangers vs Bruins regular season game')).toEqual({ first: 'Rangers', second: 'Bruins' });
    // A team whose name only contains a qualifier word keeps it ("Golden Knights" is not "night").
    expect(splitMatchup('Rangers vs Vegas Golden Knights')).toEqual({ first: 'Rangers', second: 'Vegas Golden Knights' });
    // Only qualifiers on one side: nothing left to strip to, so the words stay.
    expect(splitMatchup('Rangers vs game 3')).toEqual({ first: 'Rangers', second: 'game 3' });
    expect(opponentFor('New York Rangers', 'New York Rangers vs New York Islanders preseason game')).toBe('New York Islanders');
    expect(isAgainst('New York Rangers vs. New York Islanders (preseason)', opponentFor('New York Rangers', 'New York Rangers vs New York Islanders preseason game')!)).toBe(true);
  });

  it('does not treat a venue or a single name as a matchup', () => {
    expect(splitMatchup('Rangers at Madison Square Garden')).toBeNull();
    expect(splitMatchup('Dua Lipa')).toBeNull();
    expect(splitMatchup(null)).toBeNull();
  });

  it('matches an event against the opponent by full name, nickname or city', () => {
    expect(isAgainst('New York Rangers vs. Tampa Bay Lightning', 'Lightning')).toBe(true);
    expect(isAgainst('New York Rangers vs. Toronto Maple Leafs', 'Maple Leafs')).toBe(true);
    expect(isAgainst('New York Rangers at Boston Bruins', 'Boston')).toBe(true);
    expect(isAgainst('New York Rangers vs. New York Islanders (preseason)', 'Lightning')).toBe(false);
    // A nickname inside a longer word is not a match.
    expect(isAgainst('New York Rangers vs. Winnipeg Jets', 'Nets')).toBe(false);
  });

  it('finds the opponent named alongside a performer in the event name', () => {
    expect(opponentFor('Rangers', 'Rangers vs. Bruins')).toBe('Bruins');
    expect(opponentFor('New York Rangers', 'Bruins vs Rangers')).toBe('Bruins');
    expect(opponentFor('Knicks', 'Rangers vs Bruins')).toBeNull();
    expect(opponentFor('Knicks', null)).toBeNull();
  });
});
