import { lexiconBrowseAsk, lexiconCategory, lexiconGenre } from '@/lib/lexicon/lexicon';
import { neighbourhoodFor } from './neighbourhoods';
import { milesBetween } from './markets';
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
const SPORTS = ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer', 'minor_league', 'ncaa_regular', 'ncaa_championship', 'combat', 'motorsport', 'tennis_golf', 'emerging_sports'];
const CATALOG: Record<CategoryHint, string[]> = {
  concert: ['concert', 'festival', 'electronic_nightlife'],
  sports: SPORTS,
  nhl: ['nhl'],
  nba: ['nba'],
  mlb: ['mlb'],
  wnba: ['wnba'],
  nfl: ['nfl'],
  soccer: ['soccer'],
  theater: ['broadway', 'touring_theater', 'classical'],
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
 * The catalog categories a hint covers, minus the ones we do not cover (`BLOCKED_CATEGORIES`). Everything the
 * provider lists is covered by default (DECISION_LOG #42); with no hint, that is every category.
 */
export function pilotCategoriesFor(hint: CategoryHint | null, blocked: string[], all: readonly string[] = ALL_CATEGORIES): string[] {
  const wanted = hint ? CATALOG[hint] : all;
  return wanted.filter((c) => !blocked.includes(c));
}

/** Every catalog category the routing matrix knows (src/lib/sources/routing.ts). */
export const ALL_CATEGORIES: readonly string[] = [...new Set([...Object.values(CATALOG).flat(), 'family', 'club_concert', 'fairs_community', 'conventions', 'las_vegas', 'attractions', 'theme_parks', 'cinema', 'high_school'])];

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
  if (hint === 'comedy') return 'comedy show';
  return genre ? `${genre.words} show` : 'show';
}

/**
 * Three picks rather than the first five by date: the ones that fit the ask best, spread across different
 * days, shown in date order. `score` is how well each fits (a sub-genre that names what they asked for).
 */
export function choosePicks<T>(items: T[], n: number, of: (t: T) => { day: string; score: number }): T[] {
  const ranked = items.map((it, i) => ({ it, i, ...of(it) })).sort((a, b) => b.score - a.score || a.i - b.i);
  const out: typeof ranked = [];
  const days = new Set<string>();
  for (const r of ranked) {
    if (out.length >= n || days.has(r.day)) continue;
    out.push(r);
    days.add(r.day);
  }
  for (const r of ranked) if (out.length < n && !out.includes(r)) out.push(r);
  return out.sort((a, b) => a.i - b.i).map((r) => r.it);
}

/** How well an event's genre fits the customer's words: a shared word with the sub-genre ("indie") counts. */
export function genreFitScore(eventGenre: string | null | undefined, words: string | null | undefined): number {
  if (!eventGenre || !words) return 0;
  const sub = eventGenre.split(' / ')[1] ?? '';
  const asked = words.toLowerCase().split(/[^a-z&-]+/).filter((w) => w.length > 2 && !['and', 'the', 'roll', 'music'].includes(w));
  return asked.some((w) => sub.includes(w)) ? 1 : 0;
}

const SPORT_CATEGORIES = ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer'];

/**
 * Why a pick fits, in a few words the date-and-venue line does not already say: the kind of music, or the
 * matchup. From facts on file only (no "sold out soon", no "great seats"); null when nothing is on file.
 */
export function pickReason(e: { name: string; category: string; genre: string | null; isHome: boolean | null }): string | null {
  if (SPORT_CATEGORIES.includes(e.category)) {
    const m = /\s(?:vs\.?|v\.?|versus)\s(.+)$/i.exec(e.name.replace(/\s*\(.*?\)\s*$/, ''));
    const opponent = m?.[1]?.trim();
    // "against the Boston Celtics", but "against Boston" when the listing names only the city.
    const against = opponent ? ` against ${opponent.split(/\s+/).length > 1 ? 'the ' : ''}${opponent}` : '';
    return e.isHome || against ? `${e.isHome ? 'Home game' : 'Game'}${against}.` : null;
  }
  const sub = e.genre?.split(' / ')[1] ?? e.genre?.split(' / ')[0] ?? null;
  return sub ? `${sub.charAt(0).toUpperCase()}${sub.slice(1)}.` : null;
}

/**
 * A show that plays many nights (a Broadway run, a two-night stand, a three-game series) is one pick, not
 * one per date: same venue and the same show once extras are stripped. The first date stands for the run,
 * with how many more dates follow and the last one.
 */
export function collapseRuns<T>(items: T[], of: (t: T) => { name: string; venueId: string; day: string }): Array<{ item: T; moreDates: number; lastDay: string | null }> {
  const core = (name: string) => name.toLowerCase().replace(/\*[^*]*\*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const runs = new Map<string, { item: T; days: Set<string>; last: string }>();
  const order: string[] = [];
  for (const it of items) {
    const x = of(it);
    const key = `${core(x.name)}|${x.venueId}`;
    const run = runs.get(key);
    if (!run) {
      runs.set(key, { item: it, days: new Set([x.day]), last: x.day });
      order.push(key);
    } else {
      run.days.add(x.day);
      if (x.day > run.last) run.last = x.day;
    }
  }
  return order.map((k) => {
    const r = runs.get(k)!;
    return { item: r.item, moreDates: r.days.size - 1, lastDay: r.days.size > 1 ? r.last : null };
  });
}

/** Buying advice that belongs to the kind of event, said once on the buying email (the owner's category rules). */
export function categoryBuyingNote(category: string, venueName?: string | null): string | null {
  // Only a comedy club: a theater like Town Hall has no drink minimum, and generic caution there isn't advice (TGQA-R6).
  if (category === 'comedy') return venueName && !/\b(?:comedy|club|cellar|laugh|stand[- ]?up|improv|gotham|carolines|lounge|cafe|bar)\b/i.test(venueName) ? null : "Comedy clubs often add a drink or food minimum on top of the ticket, so check the venue's page before you go.";
  if (category === 'broadway') return 'For Broadway, TodayTix and the TKTS booth sometimes have cheaper seats for the same week.';
  return null;
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
 * A part of New York the customer named ("we're staying in Brooklyn"). The list is kept to its venues when
 * any are on, and says so; Manhattan is the venues the provider files under New York. Other markets are
 * whole metros (src/lib/domain/markets.ts).
 */
export type MarketArea = {
  label: string;
  venueCities: string[];
  providerCities: string[];
  /** A neighbourhood: venues are kept by distance from its centre, and the list widens to `parent` when none are on. */
  centre?: { lat: number; lng: number; radiusMiles: number };
  parent?: MarketArea;
  independentScene?: boolean;
};
const AREAS: Array<[RegExp, MarketArea]> = [
  [/\bbrooklyn\b/i, { label: 'Brooklyn', venueCities: ['brooklyn'], providerCities: ['Brooklyn'] }],
  [/\bmanhattan\b/i, { label: 'Manhattan', venueCities: ['new york'], providerCities: ['New York'] }],
  [/\b(queens|flushing|long island city)\b/i, { label: 'Queens', venueCities: ['queens', 'flushing', 'long island city'], providerCities: ['Flushing'] }],
  [/\b(the )?bronx\b/i, { label: 'the Bronx', venueCities: ['bronx', 'the bronx'], providerCities: ['Bronx'] }],
  [/\b(jersey city|hoboken|newark)\b/i, { label: 'New Jersey', venueCities: ['jersey city', 'hoboken', 'newark', 'east rutherford'], providerCities: ['Newark', 'East Rutherford'] }],
];

export function areaFor(city: string | null | undefined): MarketArea | null {
  if (!city) return null;
  // The most specific first: "Bushwick, Brooklyn" is Bushwick.
  const hood = neighbourhoodFor(city);
  if (hood?.centre && hood.marketId === 'new-york') {
    const parent = AREAS.find(([, a]) => a.label === hood.borough)?.[1];
    return { label: hood.label, venueCities: parent?.venueCities ?? [], providerCities: parent?.providerCities ?? [], centre: hood.centre, parent, independentScene: hood.independentScene };
  }
  return AREAS.find(([re]) => re.test(city))?.[1] ?? null;
}

/** Whether a venue is in the area: by distance for a neighbourhood (when the venue has coordinates), else by its city. */
export function venueInArea(area: MarketArea, v: { city: string | null; latitude?: number | null; longitude?: number | null }): boolean {
  if (area.centre) {
    if (v.latitude != null && v.longitude != null) return milesBetween(area.centre.lat, area.centre.lng, v.latitude, v.longitude) <= area.centre.radiusMiles;
    return false;
  }
  return area.venueCities.includes((v.city ?? '').trim().toLowerCase());
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


/** "Oct 1–7", "Oct 28 – Nov 3", "Sat, Oct 3" — how a span reads in a reply. */
export function spanLabel(from: string, to: string): string {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(`${iso}T12:00:00Z`));
  if (from === to) return fmt(from, { weekday: 'short', month: 'short', day: 'numeric' });
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth ? `${fmt(from, { month: 'short', day: 'numeric' })} to ${fmt(to, { day: 'numeric' })}` : `${fmt(from, { month: 'short', day: 'numeric' })} to ${fmt(to, { month: 'short', day: 'numeric' })}`;
}

/** Phrases that ask what is on, and the kind-of-event words, live in the lexicon (src/lib/lexicon). */
export function BROWSE_ASK_TEST(text: string): boolean {
  return lexiconBrowseAsk(text);
}

export function categoryHintFrom(text: string): CategoryHint | null {
  return lexiconCategory(text);
}

/**
 * A listing title as a person would write it (R2-EMAIL-HIERARCHY-01): an all-caps title in title case, stray spaces
 * before punctuation gone, and a long multi-act bill without its parenthetical blurbs ("Dead Man's Party (Tribute to
 * Oingo Boingo + Danny Elfman), Echoes of Pompeii (Pink Floyd Tribute)" → "Dead Man's Party and Echoes of Pompeii
 * (tribute acts)"). What it is stays said: a tribute stays a tribute.
 */
export function readableTitle(name: string): string {
  let t = name.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  if (/[A-Z]{4}/.test(t) && t === t.toUpperCase()) t = t.toLowerCase().replace(/(^|[\s(/&-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  if (t.length > 60) {
    const tribute = /\(([^)]*\btribute\b[^)]*)\)/i.test(t);
    const bare = t.replace(/\s*\([^)]*\)/g, '').replace(/\s+,/g, ',').trim();
    const acts = bare.split(/\s*,\s*/).filter(Boolean);
    const joined = acts.length > 1 ? `${acts.slice(0, -1).join(', ')} and ${acts.at(-1)}` : bare;
    if (joined.length >= 8) t = `${joined}${tribute ? ` (tribute ${acts.length > 1 ? 'acts' : 'act'})` : ''}`;
  }
  return t;
}

/** A tribute or cover act, by what its own listing says. */
export function isTributeAct(e: { name: string; genre: string | null }): boolean {
  return /\btribute\b/i.test(e.genre ?? '') || /\btribute\b|\bthe music of\b|\bsalute to\b|\bcover band\b/i.test(e.name);
}
