import { lexiconBrowseAsk, lexiconCategory, lexiconGenre } from '@/lib/lexicon/lexicon';
/**
 * "What gigs are on in New York the first week of October?" is not a request for one event; it asks what the
 * options are. Browsing answers with a short list of real scheduled events for a kind of event, a place and
 * a span of days, and asks nothing up front: quantity and budget matter once the customer has picked one.
 */

/**
 * Browsing is when nothing specific is named: no performer or team, and either the customer asked what is on or
 * named only a kind of event ("gigs", "a hockey game"). A named performer always goes to ordinary resolution.
 */
export function isBrowseRequest(x: { intent: string; performerOrTeam: string | null; eventName: string | null; categoryHint: CategoryHint | null }): boolean {
  if (x.performerOrTeam) return false;
  return x.intent === 'browse' || (x.categoryHint !== null && !x.eventName);
}

/** The kinds of event a customer names without naming a performer or team. */
export const CATEGORY_HINTS = ['concert', 'sports', 'nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer', 'theater', 'comedy'] as const;
export type CategoryHint = (typeof CATEGORY_HINTS)[number];

/** Catalog categories (catalog/sync categoryFor) each hint covers. */
const CATALOG: Record<CategoryHint, string[]> = {
  concert: ['concert', 'festival', 'electronic_nightlife'],
  sports: ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer'],
  nhl: ['nhl'],
  nba: ['nba'],
  mlb: ['mlb'],
  wnba: ['wnba'],
  nfl: ['nfl'],
  soccer: ['soccer'],
  theater: ['broadway', 'touring_theater'],
  comedy: ['comedy'],
};

/** Ticketmaster Discovery `classificationName` for the hint. */
const PROVIDER: Record<CategoryHint, string> = {
  concert: 'music',
  sports: 'sports',
  nhl: 'hockey',
  nba: 'basketball',
  mlb: 'baseball',
  wnba: 'basketball',
  nfl: 'football',
  soccer: 'soccer',
  theater: 'theatre',
  comedy: 'comedy',
};

const LABEL: Record<CategoryHint, string> = {
  concert: 'Live music',
  sports: 'Games',
  nhl: 'Hockey',
  nba: 'Basketball',
  mlb: 'Baseball',
  wnba: 'WNBA games',
  nfl: 'Football',
  soccer: 'Soccer',
  theater: 'Theater',
  comedy: 'Comedy',
};

/**
 * The catalog categories a hint covers that the pilot actually serves. Empty means the customer asked for
 * something outside the pilot (theater, comedy) and is told so rather than shown events we cannot advise on.
 */
export function pilotCategoriesFor(hint: CategoryHint | null, pilotCategories: string[]): string[] {
  const wanted = hint ? CATALOG[hint] : ['concert', 'festival', 'electronic_nightlife', 'nhl', 'nba', 'mlb', 'wnba', 'nfl'];
  return wanted.filter((c) => pilotCategories.includes(c) || (pilotCategories.includes('concert') && (c === 'festival' || c === 'electronic_nightlife')));
}

export function providerClassificationFor(hint: CategoryHint | null): string | null {
  return hint ? PROVIDER[hint] : null;
}

export function browseLabel(hint: CategoryHint | null): string {
  return hint ? LABEL[hint] : 'Events';
}

const SPORT_HINTS: readonly CategoryHint[] = ['sports', 'nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer'];

/** What the customer can name to narrow a list (`narrowBy`) or to try instead of it (`askFor`): a team for games, an artist for music. */
export function narrowByFor(hint: CategoryHint | null): { narrowBy: string; askFor: string } {
  if (hint && SPORT_HINTS.includes(hint)) return { narrowBy: 'a team or a day', askFor: 'a team' };
  if (hint === 'concert') return { narrowBy: 'an artist, venue or kind of music', askFor: 'an artist or a kind of music' };
  return { narrowBy: 'an artist, team or venue', askFor: 'an artist or team' };
}

/** One of what was asked for, in words: "football game", "hockey game", "rock or indie show". */
export function oneOfLabel(hint: CategoryHint | null, genre: GenreFamily | null): string {
  const sport: Partial<Record<CategoryHint, string>> = { sports: 'game', nhl: 'hockey game', nba: 'basketball game', mlb: 'baseball game', wnba: 'WNBA game', nfl: 'football game', soccer: 'soccer match' };
  if (hint && sport[hint]) return sport[hint]!;
  return genre ? `${genre.words} show` : 'show';
}

/** The pilot's categories in words, for telling a customer what is covered. */
export function pilotCoverageLabel(pilotCategories: string[]): string {
  const leagues = ['nhl', 'nba', 'mlb', 'wnba', 'nfl'].filter((c) => pilotCategories.includes(c)).map((c) => c.toUpperCase());
  const parts = [pilotCategories.includes('concert') ? 'concerts' : null, leagues.length ? `${leagues.length > 1 ? `${leagues.slice(0, -1).join(', ')} and ${leagues.at(-1)}` : leagues[0]} games` : null].filter(Boolean);
  return parts.join(' and ') || 'a few kinds of event';
}

/**
 * The provider lists one show several times: "Premium Seating" and "Pinstripe Pass" versions of the same game,
 * VIP and presale twins of one concert. Listings at the same venue and the same start whose names are the same
 * once the extras are stripped, or one inside the other, or that share a performer, are one show; the plainest
 * name is kept, in the position of the first.
 */
export function oneListingPerShow<T>(rows: T[], of: (r: T) => { name: string; venueId: string; startAt: Date; entityId: string | null }): T[] {
  const core = (name: string) => name.toLowerCase().replace(/\*[^*]*\*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const kept: Array<{ row: T; core: string; slot: string; entityId: string | null }> = [];
  for (const row of rows) {
    const x = of(row);
    const c = core(x.name);
    const slot = `${x.venueId}|${x.startAt.getTime()}`;
    const twin = kept.find((k) => k.slot === slot && (k.core.includes(c) || c.includes(k.core) || (!!k.entityId && k.entityId === x.entityId)));
    if (!twin) kept.push({ row, core: c, slot, entityId: x.entityId });
    else if (c.length < twin.core.length || (c.length === twin.core.length && !x.name.includes('*') && of(twin.row).name.includes('*'))) Object.assign(twin, { row, core: c });
  }
  return kept.map((k) => k.row);
}

/**
 * The pilot's one market. Venues report their own city, and "New York" to a customer means the boroughs and
 * the arenas the pilot teams play in across the river, so the catalog is filtered by this list, not by an
 * exact city match. The provider matches its city filter exactly, so it is asked about each city that holds
 * a big venue: Manhattan and Brooklyn, Yankee Stadium, Citi Field, the Prudential Center, UBS Arena and MetLife.
 */
export const NEW_YORK_AREA = {
  label: 'New York',
  providerCities: ['New York', 'Brooklyn', 'Bronx', 'Flushing', 'Newark', 'Elmont', 'East Rutherford'],
  venueCities: ['new york', 'brooklyn', 'queens', 'bronx', 'the bronx', 'flushing', 'long island city', 'staten island', 'elmont', 'uniondale', 'newark', 'east rutherford', 'hoboken', 'jersey city'],
};

/**
 * A part of the market the customer named ("we're staying in Brooklyn"). The list is kept to its venues when
 * any are on, and says so; Manhattan is the venues the provider files under New York.
 */
export type MarketArea = { label: string; venueCities: string[]; providerCities: string[] };
const AREAS: Array<[RegExp, MarketArea]> = [
  [/\bbrooklyn\b/i, { label: 'Brooklyn', venueCities: ['brooklyn'], providerCities: ['Brooklyn'] }],
  [/\bmanhattan\b/i, { label: 'Manhattan', venueCities: ['new york'], providerCities: ['New York'] }],
  [/\b(queens|flushing|long island city)\b/i, { label: 'Queens', venueCities: ['queens', 'flushing', 'long island city'], providerCities: ['Flushing'] }],
  [/\b(the )?bronx\b/i, { label: 'the Bronx', venueCities: ['bronx', 'the bronx'], providerCities: ['Bronx'] }],
  [/\b(jersey city|hoboken|newark)\b/i, { label: 'New Jersey', venueCities: ['jersey city', 'hoboken', 'newark', 'east rutherford'], providerCities: ['Newark', 'East Rutherford'] }],
];

export function areaFor(city: string | null | undefined): MarketArea | null {
  if (!city) return null;
  return AREAS.find(([re]) => re.test(city))?.[1] ?? null;
}

/**
 * A kind of music (the lexicon's genre families) matched against the provider's genre and sub-genre, which the
 * catalog stores lowercased as "rock / indie rock". `provider` is how the provider spells the genres, asked for
 * by name so a busy week's first hundred shows do not crowd them out.
 */
const GENRES: Record<string, { label: string; words: string; match: string[]; sub?: string[]; provider: string[] }> = {
  rock: { label: 'Rock and indie', words: 'rock or indie', match: ['rock', 'alternative'], sub: ['indie', 'punk'], provider: ['Rock', 'Alternative'] },
  jazz: { label: 'Jazz', words: 'jazz', match: ['jazz'], provider: ['Jazz'] },
  'hip-hop': { label: 'Hip-hop', words: 'hip-hop', match: ['hip-hop', 'hip hop', 'rap'], provider: ['Hip-Hop/Rap'] },
  electronic: { label: 'Electronic', words: 'electronic music', match: ['electronic', 'dance'], sub: ['techno', 'house'], provider: ['Dance/Electronic'] },
  pop: { label: 'Pop', words: 'pop', match: ['pop'], provider: ['Pop'] },
  country: { label: 'Country', words: 'country', match: ['country'], sub: ['americana', 'bluegrass'], provider: ['Country'] },
  'r&b': { label: 'R&B and soul', words: 'R&B or soul', match: ['r&b'], sub: ['soul', 'funk'], provider: ['R&B'] },
  metal: { label: 'Metal', words: 'metal', match: ['metal'], sub: ['hardcore'], provider: ['Metal'] },
  folk: { label: 'Folk', words: 'folk', match: ['folk'], sub: ['singer-songwriter'], provider: ['Folk'] },
  latin: { label: 'Latin', words: 'Latin music', match: ['latin'], sub: ['reggaeton', 'salsa'], provider: ['Latin'] },
  blues: { label: 'Blues', words: 'blues', match: ['blues'], provider: ['Blues'] },
};
export type GenreFamily = { key: string; label: string; words: string; match: string[]; sub?: string[]; provider: string[] };

/** The family a customer's words for music name ("indie rock and roll" → rock), or null. */
export function genreFamilyFor(words: string | null | undefined): GenreFamily | null {
  if (!words) return null;
  const key = GENRES[words.toLowerCase()] ? words.toLowerCase() : lexiconGenre(words)?.value;
  return key && GENRES[key] ? { key, ...GENRES[key] } : null;
}

/**
 * The main genre decides; a sub-genre only counts for the words that are distinctive in it. "Pop / pop rock"
 * is pop, not rock, and "rock / indie rock" and "other / punk" are both rock.
 */
export function genreMatches(family: GenreFamily, eventGenre: string | null | undefined): boolean {
  if (!eventGenre) return false;
  const [main = '', sub = ''] = eventGenre.split(' / ');
  return family.match.some((m) => main.includes(m)) || (family.sub ?? []).some((m) => sub.includes(m));
}

const NY_WORDS = /\b(new york|nyc|ny|manhattan|brooklyn|queens|bronx|staten island|long island|jersey city|hoboken|newark)\b/i;

/** Whether a city the customer named is the pilot market. Null (not said) is treated as the market, and said so. */
export function isPilotMarket(city: string | null | undefined): boolean {
  return !city || NY_WORDS.test(city);
}

export function inPilotVenueCity(city: string | null | undefined): boolean {
  return !!city && NEW_YORK_AREA.venueCities.includes(city.trim().toLowerCase());
}

/** "Oct 1–7", "Oct 28 – Nov 3", "Sat, Oct 3" — how a span reads in a reply. */
export function spanLabel(from: string, to: string): string {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(`${iso}T12:00:00Z`));
  if (from === to) return fmt(from, { weekday: 'short', month: 'short', day: 'numeric' });
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth ? `${fmt(from, { month: 'short', day: 'numeric' })}–${fmt(to, { day: 'numeric' })}` : `${fmt(from, { month: 'short', day: 'numeric' })} – ${fmt(to, { month: 'short', day: 'numeric' })}`;
}

/** Phrases that ask what is on, and the kind-of-event words, live in the lexicon (src/lib/lexicon). */
export function BROWSE_ASK_TEST(text: string): boolean {
  return lexiconBrowseAsk(text);
}

export function categoryHintFrom(text: string): CategoryHint | null {
  return lexiconCategory(text);
}
