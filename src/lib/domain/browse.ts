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
export const CATEGORY_HINTS = ['concert', 'sports', 'nhl', 'nba', 'mlb', 'wnba', 'theater', 'comedy'] as const;
export type CategoryHint = (typeof CATEGORY_HINTS)[number];

/** Catalog categories (catalog/sync categoryFor) each hint covers. */
const CATALOG: Record<CategoryHint, string[]> = {
  concert: ['concert', 'festival', 'electronic_nightlife'],
  sports: ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer'],
  nhl: ['nhl'],
  nba: ['nba'],
  mlb: ['mlb'],
  wnba: ['wnba'],
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
  theater: 'Theater',
  comedy: 'Comedy',
};

/**
 * The catalog categories a hint covers that the pilot actually serves. Empty means the customer asked for
 * something outside the pilot (theater, comedy) and is told so rather than shown events we cannot advise on.
 */
export function pilotCategoriesFor(hint: CategoryHint | null, pilotCategories: string[]): string[] {
  const wanted = hint ? CATALOG[hint] : ['concert', 'festival', 'electronic_nightlife', 'nhl', 'nba', 'mlb', 'wnba'];
  return wanted.filter((c) => pilotCategories.includes(c) || (pilotCategories.includes('concert') && (c === 'festival' || c === 'electronic_nightlife')));
}

export function providerClassificationFor(hint: CategoryHint | null): string | null {
  return hint ? PROVIDER[hint] : null;
}

export function browseLabel(hint: CategoryHint | null): string {
  return hint ? LABEL[hint] : 'Events';
}

/**
 * The pilot's one market. Venues report their own city, and "New York" to a customer means the boroughs and
 * the arenas the pilot teams play in across the river, so the catalog is filtered by this list, not by an
 * exact city match. The provider is asked about the two cities that hold nearly all of the venues.
 */
export const NEW_YORK_AREA = {
  label: 'New York',
  providerCities: ['New York', 'Brooklyn'],
  venueCities: ['new york', 'brooklyn', 'queens', 'bronx', 'the bronx', 'flushing', 'long island city', 'staten island', 'elmont', 'uniondale', 'newark', 'east rutherford', 'hoboken', 'jersey city'],
};

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

/** Phrases that ask what is on rather than for a named event. */
export const BROWSE_ASK = /\b(what(?:'s| is)? on|what(?:'s| is) happening|what (?:options|choices) (?:do i|are there)|what can (?:i|we) (?:see|go to)|what should (?:i|we) (?:see|go to)|any (?:good )?(?:shows|gigs|concerts|games)|anything (?:good|fun) (?:on|happening)|recommend(?:ations?)?|suggest(?:ions?)?|things to (?:do|see))\b/i;

/**
 * The kind of event from the customer's own words. First match wins, so the more specific sport names are
 * checked before "game". "Show" alone is left unread: it is a concert, a musical or a comedy set.
 */
const HINT_WORDS: Array<[RegExp, CategoryHint]> = [
  [/\b(nhl|hockey)\b/i, 'nhl'],
  [/\b(wnba)\b/i, 'wnba'],
  [/\b(nba|basketball)\b/i, 'nba'],
  [/\b(mlb|baseball)\b/i, 'mlb'],
  [/\b(gigs?|concerts?|live music|music|bands?|dj sets?|festivals?)\b/i, 'concert'],
  [/\b(broadway|musicals?|theat(?:er|re)|plays?)\b/i, 'theater'],
  [/\b(comedy|stand-?up|comedians?)\b/i, 'comedy'],
  [/\b(sports?|games?|matches)\b/i, 'sports'],
];

export function categoryHintFrom(text: string): CategoryHint | null {
  for (const [re, hint] of HINT_WORDS) if (re.test(text)) return hint;
  return null;
}
