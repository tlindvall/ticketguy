import nfl from './teams/nfl.json';
import nba from './teams/nba.json';
import wnba from './teams/wnba.json';
import nhl from './teams/nhl.json';
import mlb from './teams/mlb.json';
import mls from './teams/mls.json';
import nwsl from './teams/nwsl.json';
import ncaa from './teams/ncaa.json';

/**
 * Every team the ticket brief can draw (scripts/build-team-brands.ts writes the JSON beside this file): colours, short
 * name, the slugs a provider may name it by, and its logo, hosted by us under public/. The files are the source;
 * syncTeamBrands copies them into brand_assets on every deploy.
 */
export type Sport = 'football' | 'basketball' | 'hockey' | 'baseball' | 'soccer';
export type TeamBrand = {
  slug: string;
  name: string;
  shortName: string | null;
  league: 'NFL' | 'NBA' | 'WNBA' | 'NHL' | 'MLB' | 'MLS' | 'NWSL' | 'NCAA';
  /** Null for a school, which plays every sport: the event says which. */
  sport: Sport | null;
  aliases: string[];
  primaryColor: string;
  secondaryColor: string;
  /** Path under public/, e.g. "/brand/logos/nhl/new-york-rangers.png"; null when the source had none. */
  logo: string | null;
};

export const TEAM_BRANDS: readonly TeamBrand[] = [nfl, nba, wnba, nhl, mlb, mls, nwsl, ncaa].flat() as TeamBrand[];
