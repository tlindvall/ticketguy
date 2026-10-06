/**
 * What to call an event and its seats in a reply. A Rangers game is a game; a concert, comedy night or Broadway
 * performance is a show (live Oct 5: "Search StubHub for this game" under a Brooklyn Steel concert). Every customer
 * sentence that names the kind of event takes its word from here, never a hard-coded "game".
 */
// Every sports category the catalog sync assigns (catalog/sync categoryFor), so a minor-league or college game is a game.
export const SPORT_CATEGORIES = ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer', 'ncaaf', 'ncaab', 'mls', 'minor_league', 'ncaa_regular', 'ncaa_championship', 'combat', 'motorsport', 'tennis_golf', 'emerging_sports'];

export type EventNoun = 'game' | 'show';

export function eventNounFor(category: string | null | undefined): EventNoun {
  return category && SPORT_CATEGORIES.includes(category) ? 'game' : 'show';
}

const isGa = (section: string | null | undefined, row: string | null | undefined) =>
  /^(?:ga|general admission)\b|\bgeneral admission$|\bga$/i.test((section ?? '').trim()) || /^(?:ga|general admission)$/i.test((row ?? '').trim());

/**
 * A listing's place, as a person would say it: "Section 214, Row 8", or "general admission" for a GA listing, whose
 * feed rows read "Section General Admission, Row GA" (live Oct 5). Lower case, for use inside a sentence; null when
 * the listing names neither.
 */
export function seatPhrase(section: string | null | undefined, row: string | null | undefined, sep = ', '): string | null {
  if (isGa(section, row)) return /\bfloor\b/i.test(section ?? '') ? 'general admission floor' : 'general admission';
  return [section ? `Section ${section}` : null, row ? `Row ${row}` : null].filter(Boolean).join(sep) || null;
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const CATEGORY_LABELS: Record<string, string> = {
  concert: 'Concert', festival: 'Festival', electronic_nightlife: 'Live music', comedy: 'Comedy', broadway: 'Theater', touring_theater: 'Theater', classical: 'Classical',
  nhl: 'NHL', nba: 'NBA', mlb: 'MLB', wnba: 'WNBA', nfl: 'NFL', mls: 'MLS', soccer: 'Soccer', ncaaf: 'College football', ncaab: 'College basketball', minor_league: 'Minor league',
  ncaa_regular: 'College sports', ncaa_championship: 'College sports', combat: 'Fight night', motorsport: 'Motorsport', tennis_golf: 'Sport', emerging_sports: 'Sport',
};

/** The small label above an event's name on the ticket brief ("Concert", "NHL"); "Event" when the category is unknown. */
export function categoryLabel(category: string | null | undefined): string {
  return (category && CATEGORY_LABELS[category]) ?? (eventNounFor(category) === 'game' ? 'Game' : 'Event');
}

/** Live-music categories: the generic concert artwork may decorate their brief, nothing else's. */
export const isLiveMusic = (category: string | null | undefined) => !!category && ['concert', 'festival', 'electronic_nightlife'].includes(category);
