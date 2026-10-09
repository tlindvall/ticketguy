import { describe, expect, it } from 'vitest';
import { ROSTER_NAMES, rosterTeam } from '@/lib/domain/team-names';
import { correctToKnown } from '@/lib/domain/name-correction';
import { TEAM_BRANDS } from '@/lib/brand/teams';

describe('what fans call a team is that team', () => {
  it.each([
    ['Bolts', null, null], // the Lightning and the Chargers both answer to it
    ['Bolts', 'nhl', 'Tampa Bay Lightning'],
    ['Habs', null, 'Montreal Canadiens'],
    ['Niners', null, 'San Francisco 49ers'],
    ['Sixers', null, 'Philadelphia 76ers'],
    ['Bama', null, 'Alabama Crimson Tide'],
    ['Notre Dame', null, 'Notre Dame Fighting Irish'],
    ['Bronx Bombers', null, 'New York Yankees'],
    ['NYCFC', null, 'New York City FC'],
    ['knicks', null, 'New York Knicks'],
    ["St Johns", null, "St. John's Red Storm"],
  ])('%s (%s) → %s', (typed, hint, team) => expect(rosterTeam(typed, hint)).toBe(team));

  it('a name several teams answer to is nobody in particular, until the league is named', () => {
    expect(rosterTeam('Rangers')).toBeNull();
    expect(rosterTeam('Rangers', 'nhl')).toBe('New York Rangers');
    expect(rosterTeam('Rangers', 'mlb')).toBe('Texas Rangers');
    expect(rosterTeam('Giants')).toBeNull();
    expect(rosterTeam('Cardinals')).toBeNull();
    expect(rosterTeam('Tigers', 'ncaaf')).toBeNull(); // Auburn, Clemson, LSU, Missouri
    expect(rosterTeam('Taylor Swift')).toBeNull();
  });

  it('every team’s full name means that team and no other', () => {
    for (const t of TEAM_BRANDS) expect(rosterTeam(t.name), t.name).toBe(t.name);
  });

  it('a typo of a roster name is caught without the team being in the catalog', () => {
    expect(correctToKnown('Norte Dane', [...ROSTER_NAMES])).toEqual({ from: 'Norte Dane', to: 'Notre Dame Fighting Irish' });
    expect(correctToKnown('Kincks', [...ROSTER_NAMES])).toEqual({ from: 'Kincks', to: 'New York Knicks' });
    expect(correctToKnown('Coldplay', [...ROSTER_NAMES])).toBeNull();
    expect(correctToKnown('Kings of Leon', [...ROSTER_NAMES])).toBeNull();
  });
});
