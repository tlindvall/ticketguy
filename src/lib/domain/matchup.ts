/**
 * "Rangers vs Lightning" names a game, not a team. The extractor sometimes returns the whole matchup as the
 * performer, and no entity is called "New York Rangers vs Tampa Bay Lightning" — so a real game on file came
 * back as "no scheduled event". A matchup is split into its two sides; the side we know is the team, and the
 * other side narrows that team's games to the ones against it.
 *
 * "at" is deliberately not a separator: "Rangers at Madison Square Garden" names a venue, not an opponent.
 */
const SEPARATOR = /\s+(?:vs\.?|v\.?|versus|against|@)\s+/i;

export type Matchup = { first: string; second: string };

export function splitMatchup(text: string | null | undefined): Matchup | null {
  if (!text) return null;
  const parts = text.split(SEPARATOR).map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  // Trailing qualifiers ("(preseason)", "game 3") are not part of the opponent's name.
  const clean = (s: string) => s.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  const first = clean(parts[0]!);
  const second = clean(parts[1]!);
  return first && second ? { first, second } : null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Whether a catalog event is against the named opponent. Event names spell teams in full ("… vs. Tampa Bay
 * Lightning") while customers often use the nickname ("Lightning") or the city ("Boston"), so the full name
 * or its last word is enough — "Red Wings" and "Maple Leafs" keep a distinctive last word.
 */
export function isAgainst(eventName: string, opponent: string): boolean {
  const ev = ` ${norm(eventName)} `;
  const opp = norm(opponent);
  if (!opp) return true;
  if (ev.includes(` ${opp} `)) return true;
  const last = opp.split(' ').at(-1)!;
  return last.length >= 3 && ev.includes(` ${last} `);
}

/**
 * The opponent named alongside a performer, when the event name is a matchup: for performer "Rangers" and event
 * name "Rangers vs. Bruins" it is "Bruins". Null when there is no matchup or the performer is on neither side.
 */
export function opponentFor(performer: string, eventName: string | null | undefined): string | null {
  const m = splitMatchup(eventName);
  if (!m) return null;
  const p = norm(performer);
  if (norm(m.first).includes(p) || p.includes(norm(m.first))) return m.second;
  if (norm(m.second).includes(p) || p.includes(norm(m.second))) return m.first;
  return null;
}

/**
 * Against the same place's team under another name: a team renamed since a screenshot or a model learned it ("Utah
 * Hockey Club" is the Utah Mammoth now). The other side of the event must start with the opponent's place, and the
 * place must not be the performer's own ("New York" never matches the Rangers' own side).
 */
export function isAgainstPlace(eventName: string, opponent: string, performer: string): boolean {
  const m = splitMatchup(eventName);
  if (!m) return false;
  const mine = norm(performer).split(' ').at(-1) ?? '';
  const other = ` ${norm(mine && norm(m.first).includes(mine) ? m.second : m.first)} `;
  const words = norm(opponent).replace(/\b(?:hockey|football|soccer|basketball|baseball)? ?(?:club|fc|sc|cf)\b/g, '').trim().split(' ');
  const place = (words.length > 1 ? words.slice(0, -1) : words).join(' ');
  if (place.length < 4 || norm(performer).startsWith(place)) return false;
  return other.startsWith(` ${place} `);
}
