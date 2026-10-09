/**
 * Where a customer says they live, from their own words — never from the event, the venue or the email domain
 * (ENGINEERING_SPEC §1). The two outcomes are not symmetric: a wrong 'NON_US' closes a real customer's request,
 * a wrong null only leaves the "country unconfirmed" flag a reviewer already sees. So 'NON_US' needs a named
 * non-US place or an explicit "not in the US"; anything unrecognised is null and changes nothing.
 */
import { homeFromStatement } from './home-market';

export type Residence = 'US' | 'NON_US';

const US_STATES =
  'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|washington,? d\\.?c\\.?';
/** Pilot-area places people name instead of a state. */
const US_PLACES = 'nyc|brooklyn|queens|the bronx|bronx|manhattan|staten island|long island|jersey city|hoboken|westchester';
const US_WORDS = 'u\\.?s\\.?a?\\.?|united states|america|the states|stateside';
const US_ANY = `${US_WORDS}|${US_STATES}|${US_PLACES}`;

const NON_US_PLACES =
  'canada|mexico|u\\.?k\\.?|united kingdom|england|britain|great britain|scotland|wales|ireland|northern ireland|france|germany|spain|portugal|italy|netherlands|holland|belgium|switzerland|austria|sweden|norway|denmark|finland|iceland|poland|israel|australia|new zealand|japan|china|korea|india|brazil|argentina|colombia|chile|peru|europe|asia|london|paris|toronto|montreal|vancouver|berlin|dublin|sydney';

const NOT_US = new RegExp(`\\b(not|outside(?: of)?|n't)\\s+(?:in\\s+|from\\s+|based in\\s+)?(?:the\\s+)?(?:${US_WORDS})\\b|\\bnon[- ]us\\b`, 'i');
const US = new RegExp(`\\b(${US_ANY})\\b`, 'i');
const NON_US = new RegExp(`\\b(${NON_US_PLACES})\\b`, 'i');
const US_AT_START = new RegExp(`^(?:the\\s+)?(?:${US_ANY})\\b`, 'i');
const NON_US_AT_START = new RegExp(`^(?:the\\s+)?(?:${NON_US_PLACES})\\b`, 'i');

/** Classifies a statement that is already about residence (the model's `countryStatement`). */
export function classifyResidence(statement: string | null | undefined): Residence | null {
  if (!statement) return null;
  if (NOT_US.test(statement)) return 'NON_US';
  if (NON_US.test(statement) && !US.test(statement)) return 'NON_US';
  if (US.test(statement) || homeFromStatement(statement)) return 'US';
  return null;
}

/** Travel words that turn "I'm in New York" from where someone lives into where they are this week. */
const TRAVEL_CUE = /\b(visit(?:ing)?|vacation|holiday|trip|travel(?:l)?ing|in town|flying in|for the weekend)\b/i;

/**
 * The customer's own statement of where they live or are based, found in free text, or null. Deliberately
 * narrow: the words right after "I'm in / I live in / we're from / based in" must BE a recognised place, so
 * "I'm in a hurry", "I'm in need of tickets for us" or "I'm in the market" say nothing about residence. A city
 * the customer wants tickets in is never read as where they live, and "I'm in New York" next to a travel word
 * ("visiting", "for the weekend") is not residence either.
 */
export function findResidenceStatement(text: string): string | null {
  const negated = new RegExp(`\\b(?:i(?:'m| am)|we(?:'re| are))\\s+(?:not\\s+(?:in|from|based in)|outside(?: of)?)\\s+(?:the\\s+)?(?:${US_WORDS})\\b`, 'i').exec(text);
  if (negated) return negated[0];
  const re = /\b(i(?:'m| am)|we(?:'re| are)|i live|we live|i(?:'m| am) (?:currently )?(?:based|living)|we(?:'re| are) (?:based|living)|visiting)\s+(in|from|out of)\s+([^.!?,;\n]{1,40})/gi;
  for (const m of text.matchAll(re)) {
    const verb = m[1]!.toLowerCase();
    const prep = m[2]!.toLowerCase();
    const place = m[3]!;
    if (NON_US_AT_START.test(place)) return m[0].trim();
    // A metro we serve is a US place too ("I live in Dallas", "we're based in the Bay Area").
    if (!US_AT_START.test(place) && !homeFromStatement(m[0])) continue;
    // "I'm in NYC" is residence for a New Yorker and a hotel address for a tourist; only the second mentions travel.
    const weak = (verb === "i'm" || verb === 'i am' || verb === "we're" || verb === 'we are') && prep === 'in';
    if (verb === 'visiting' || (weak && TRAVEL_CUE.test(text))) continue;
    return m[0].trim();
  }
  return null;
}
