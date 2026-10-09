import { MARKETS, inMarket, marketFor, type Market } from './markets';

/**
 * Where a customer is based, kept per contact so a bare "Giants" or "Metallica" next month means the ones near
 * them. Two kinds of evidence, never mixed up:
 *  - said: their own words ("I live in Dallas", "we're based in Brooklyn"). Stored, and it outranks anything
 *    inferred until they say somewhere else.
 *  - inferred: where the events they asked about were. Read fresh each time from their recent requests, the
 *    place most of them were in, so one trip to Vegas doesn't move a New Yorker.
 * Either way it only breaks ties and fills a missing city; the reply says what it assumed, so they can correct it.
 */

/** Words after the place that are not part of it: "Brooklyn and want two tickets", "Dallas but the game's in NY". */
const AFTER_PLACE = /\s+(?:and|but|so|with|for|since|because|now|too|these days|currently|though)\b.*$/i;

/**
 * The market a residence statement names ("I live in Dallas", "we're based out of the Bay Area", "I'm in
 * Brooklyn"), or null. Only a metro we know counts: a state ("Texas") or a town we have no metro for says too
 * little to choose a team or a show by, and a non-US place is handled by the country rule, not here.
 */
export function homeFromStatement(statement: string | null | undefined): Market | null {
  if (!statement) return null;
  if (/\b(?:not|n't|outside)\b/i.test(statement)) return null;
  const m = /\b(?:in|from|out of)\s+(?:the\s+)?([^.!?;\n]{2,40})/i.exec(statement);
  if (!m) return null;
  const place = m[1]!.replace(AFTER_PLACE, '').replace(/[,\s]+$/, '').trim();
  // A place is a few words; "in for 2 tickets to the Bay Area show" is not someone living in the Bay Area.
  if (!place || place.split(/\s+/).length > 4) return null;
  const named = MARKETS.find((mk) => mk.match.exec(place)?.index === 0);
  if (named) return named;
  const market = marketFor(place);
  return market && !market.id.startsWith('city:') ? market : null;
}

/** The market a venue is in: a metro we know, else its own city. Null for a venue outside the US or with no city. */
export function marketOfVenue(v: { city: string | null; state?: string | null; country?: string | null; latitude?: number | null; longitude?: number | null }): Market | null {
  if (v.country && v.country !== 'US') return null;
  return MARKETS.find((mk) => inMarket(v, mk)) ?? marketFor(v.city, v.state ?? null);
}

/**
 * The place most of these requests were in, newest first. A tie goes to the newer one: with one request in
 * New York and one in Vegas there is no telling, and the latest is what today's code already assumed.
 */
export function homeByVotes(newestFirst: Array<Market | null>): Market | null {
  const tally = new Map<string, { market: Market; n: number; first: number }>();
  newestFirst.forEach((mk, i) => {
    if (!mk) return;
    const row = tally.get(mk.id);
    if (row) row.n += 1;
    else tally.set(mk.id, { market: mk, n: 1, first: i });
  });
  const best = [...tally.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0];
  return best?.market ?? null;
}
