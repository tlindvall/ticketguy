/**
 * What to call an event and its seats in a reply. A Rangers game is a game; a concert, comedy night or Broadway
 * performance is a show (live Oct 5: "Search StubHub for this game" under a Brooklyn Steel concert). Every customer
 * sentence that names the kind of event takes its word from here, never a hard-coded "game".
 */
export const SPORT_CATEGORIES = ['nhl', 'nba', 'mlb', 'wnba', 'nfl', 'soccer', 'ncaaf', 'ncaab', 'mls'];

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
