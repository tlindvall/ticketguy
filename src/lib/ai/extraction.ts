import { unglue } from '@/lib/domain/event-constraints';
import { z } from 'zod';
import { RequestExtractionSchema, type RequestExtraction } from '@/lib/domain/types';
import { dateWindowFor, resolveRelativeDate } from '@/lib/domain/dates';
import { classifyOptOutText } from '@/lib/domain/suppression';
import { findResidenceStatement } from '@/lib/domain/country';
import { BROWSE_ASK_TEST, categoryHintFrom } from '@/lib/domain/browse';
import { MARKETS } from '@/lib/domain/markets';
import { neighbourhoodFor } from '@/lib/domain/neighbourhoods';
import { stateCodeFor } from '@/lib/domain/us-states';
import { lexiconGenre, lexiconPriceCheck, lexiconQuantity, lexiconResaleAsked, lexiconNotifyAsked, lexiconVagueQuantity, lexiconWantsMore } from '@/lib/lexicon/lexicon';

/**
 * Stage 1: classify + extract. Two implementations share one strict schema:
 *  - FixtureExtractor: deterministic rules for local demos/tests (no network, no cost).
 *  - AnthropicExtractor: Messages API structured output (src/lib/ai/anthropic.ts).
 * Both return null for unknown facts; nothing is invented.
 */
export type ExtractionInput = {
  messageId: string;
  text: string; // sanitized, quoted content already stripped
  subject: string | null;
  receivedAt: Date;
  venueTimeZone: string | null;
  /** Names known to the pilot entity table (slug → display name, kind) to keep entity matching deterministic. */
  knownEntities: Array<{ name: string; aliases: string[]; kind: 'artist' | 'team'; category: string }>;
};

export interface Extractor {
  readonly name: string;
  extract(input: ExtractionInput): Promise<RequestExtraction>;
}

export const EXTRACTION_SCHEMA = RequestExtractionSchema;
export type ExtractionSchema = z.infer<typeof EXTRACTION_SCHEMA>;

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, single: 1, pair: 2, couple: 2 };

/** "my wife and I" states a party of two as plainly as "two tickets" does. */
const COUPLE = /\b(?:my (?:wife|husband|partner|girlfriend|boyfriend) and (?:i|me)|(?:me|myself) and my (?:wife|husband|partner|girlfriend|boyfriend)|both of us|my (?:wife|husband|partner|girlfriend|boyfriend|friend) is coming(?: with me)?|with my (?:wife|husband|partner|girlfriend|boyfriend)\b(?!\s+and\b)|one (?:wheelchair )?(?:space|spot|seat) (?:and|plus|with) one (?:\w+ )?(?:companion )?(?:seat|space))\b/i;

/**
 * Tickets they need, not tickets a listing has: "the screenshot still says $52 each for THREE tickets… We now need
 * four people together" is four (TGQA-R6 15). A sentence about a listing only counts when nothing else gives one.
 */
function parseQuantity(t: string): { value: number | null; quote: string | null } {
  const sentences = t.split(/(?<=[.!?])\s+/);
  const listingSentence = (x: string) => /\b(?:screenshot|listing|image|the offer|seller|(?:it|that|this) (?:says|shows)|still says|still shows)\b/i.test(x);
  if (sentences.length > 1 && sentences.some(listingSentence)) {
    const own = parsePartyQuantity(sentences.filter((x) => !listingSentence(x)).join(' '));
    if (own.value !== null) return own;
  }
  return parsePartyQuantity(t);
}

/** "Do we buy two tickets or three?": a choice they haven't made, never a declared quantity (R1-A04). */
const COUNT_CHOICE = /\b(?:one|two|three|four|five|six|\d{1,2})\s+(?:tickets?|seats?|admissions?)\s+or\s+(?:one|two|three|four|five|six|\d{1,2})\b|\b(?:one|two|three|four|five|six|\d{1,2})\s+or\s+(?:one|two|three|four|five|six|\d{1,2})\s+(?:tickets?|seats?|admissions?)\b/i;
export function quantityIsOpenChoice(t: string): boolean {
  return COUNT_CHOICE.test(t);
}

function parsePartyQuantity(t: string): { value: number | null; quote: string | null } {
  if (COUNT_CHOICE.test(t)) return { value: null, quote: null };
  // "One wheelchair space and one companion seat", "my partner is coming with me": two, said without a number.
  const pairOf = COUPLE.exec(t);
  // A number of tickets beats a head count when both are said: "Four Hamilton tickets … two adults and kids aged
  // 12 and 15" is four tickets, not the two adults (TGQA-R6 18). Up to four words may sit between the number and
  // the noun: "4 Knicks tickets", "two lower bowl seats".
  // A price is not a count: "$90 per ticket" is not ninety tickets.
  const tickets = /(?<!\$\s?|\d[.,])\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?!per\b|a\b|each\b|\d|(?:one|two|three|four|five|six|seven|eight|nine|ten)\b)[a-z'.-]+\s+){0,4}?(?:tickets?|tix)\b/i.exec(t);
  if (tickets && !(pairOf && /^one\b/i.test(tickets[1]!))) {
    const v = NUM_WORDS[tickets[1]!.toLowerCase()] ?? Number(tickets[1]);
    if (Number.isFinite(v) && v > 0) return { value: v, quote: tickets[0] };
  }
  if (pairOf) return { value: 2, quote: pairOf[0] };
  // "Cap is $500 for all four", "for all 3": the whole party, said as a count.
  const allN = /\bfor all\s+(two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b(?!\s*(?:%|dollars|\$))/i.exec(t);
  if (allN) {
    const v = NUM_WORDS[allN[1]!.toLowerCase()] ?? Number(allN[1]);
    if (Number.isFinite(v) && v > 1) return { value: v, quote: allN[0] };
  }
  // "one adult must sit with each child" describes the seating, not a party of one.
  const m = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|a|single|pair|couple)\s*(?:of\s+us|people|tickets?|seats?|tix|adults?(?!\s+(?:must|can|should|will|has to|needs to|sits?|per)\b)|friends?)\b/i.exec(t) ?? /(?<!\$\s?|\d[.,])\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?!per\b|a\b|each\b|\d|(?:one|two|three|four|five|six|seven|eight|nine|ten)\b)[a-z'.-]+\s+){1,3}(?:tickets?|seats?|tix)\b/i.exec(t) ?? /\b(?:party|group|family|household|crew)\s+of\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(t) ?? /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:together)\b/i.exec(t);
  if (!m) {
    const couple = COUPLE.exec(t);
    if (couple) return { value: 2, quote: couple[0] };
    // "just me", "me and my son", "the two of us" — the lexicon's party phrases.
    const phrase = lexiconQuantity(t);
    return phrase ? { value: phrase.value, quote: phrase.quote } : { value: null, quote: null };
  }
  const raw = m[1]!.toLowerCase();
  const v = NUM_WORDS[raw] ?? Number(raw);
  // "I want to go with a friend" is two tickets, not one; "me and three friends" is four. "A ticket for a friend"
  // stays one: only friends someone goes *with* add the sender.
  const withFriends = /friends?$/i.test(m[0]) && /\b(?:with|me and|myself and|and I)\s*$/i.test(t.slice(Math.max(0, m.index - 12), m.index));
  // "two adults and our 16-year-old" is three; "two adults and two kids" is four (live G02).
  const after = /adults?$/i.test(m[0]) ? /^\s*(?:,|and|plus|\+)\s*(?:(?:our|my|a|one|their)\s+(?:\d{1,2}[- ]?(?:year[- ]?old|yo)|son|daughter|kid|child|teen(?:ager)?|boy|girl|nephew|niece|grand(?:son|daughter))\b|(\d{1,2}|two|three|four|five)\s+(?:kids|children|teens|teenagers|boys|girls)\b|(?:our\s+|my\s+|their\s+)?(?:kids|children)\s+(?:aged\s+|ages\s+)?\d{1,2}\s*(?:,\s*\d{1,2}\s*)*(?:and|&)\s*\d{1,2}\b)/i.exec(t.slice(m.index + m[0].length)) : null;
  // "kids aged 12 and 15" is two children: one per age named.
  const ages = after && !after[1] ? after[0].match(/\b\d{1,2}\b(?![- ]?(?:year|yo))/g)?.length ?? 0 : 0;
  const plus = after ? (after[1] ? NUM_WORDS[after[1].toLowerCase()] ?? Number(after[1]) : ages >= 2 ? ages : 1) : 0;
  return Number.isFinite(v) && v > 0 ? { value: (withFriends ? v + 1 : v) + plus, quote: after ? m[0] + after[0] : m[0] } : { value: null, quote: null };
}

function parseBudget(t: string): { cents: number | null; basis: 'per_ticket' | 'whole_party' | null; quote: string | null } {
  // "under 3 bills all in" is $300.
  const bills = /\b(?:under|up to|max(?:imum)?|about|around)?\s*(\d|one|two|three|four|five|six|seven|eight|nine|ten)\s+bills?\b\s*(all[- ]in|total|each|apiece)?/i.exec(t);
  if (bills && !/\$\s?\d/.test(t)) {
    const n = NUM_WORDS[bills[1]!.toLowerCase()] ?? Number(bills[1]);
    return { cents: n * 10_000, basis: /each|apiece/i.test(bills[2] ?? '') ? 'per_ticket' : bills[2] ? 'whole_party' : null, quote: bills[0].trim() };
  }
  const AMOUNT = /(?:under|below|max(?:imum)?|budget(?: is| of)?|up to|no more than|around|about|<|≤)?\s*\$\s?(\d{1,5}(?:[.,]\d{2})?)\s*(?:is\s+|are\s+)?(total|all[- ]in|for (?:all|both|everyone|the (?:two|three|four|five|six|group|pair)|the (?:whole |entire )?(?:order|lot|block|party|group))|combined|altogether|each|per (?:ticket|person|seat)|a (?:ticket|seat|person)|apiece|pp)?/i;
  // An amount they call a budget or cap beats the first price in the message: "Offer A is $190 TOTAL… Budget $230
  // TOTAL" is a $230 budget (TGQA-R8 17). Otherwise the first amount, as before.
  const worded = /\b(?:budget|cap|spend(?: up to)?|max(?:imum)?|no more than|at most|up to|under)\b(?:\s+(?:is|of|to|stays|now|still|remains|was))*\s*(?:\$|\bat\s+\$)/i.exec(t);
  const inWorded = worded ? AMOUNT.exec(t.slice(worded.index)) : null;
  // "$100 total cap", "$300 all-in budget": the amount said before the word that makes it the cap, which a
  // smaller line item earlier in the message ("two $9 items") must not displace (R1-A03).
  const before = inWorded ? null : /\$\s?(\d{1,5}(?:[.,]\d{2})?)\s+(?:(total|all[- ]in|whole[- ]night|overall|combined)\s+)?(?:budget|cap|limit|max(?:imum)?)\b/i.exec(t);
  if (before) {
    const cents = Math.round(Number(before[1]!.replace(',', '.')) * 100);
    return { cents, basis: before[2] ? 'whole_party' : null, quote: before[0] };
  }
  const m = inWorded ?? AMOUNT.exec(t);
  const at = inWorded ? worded!.index + inWorded.index : m?.index ?? 0;
  if (!m) return { cents: null, basis: null, quote: null };
  const cents = Math.round(Number(m[1]!.replace(',', '.')) * 100);
  const q = (m[2] ?? '').toLowerCase();
  let basis: 'per_ticket' | 'whole_party' | null = null;
  if (/total|all|combined|altogether|for/.test(q)) basis = 'whole_party';
  else if (/each|per|apiece|pp|a /.test(q)) basis = 'per_ticket';
  // "Raise the total budget to $720", "the total is under $450 with fees": the word comes before the amount.
  else if (/\btotal\b/i.test(t.slice(Math.max(0, at - 30), at))) basis = 'whole_party';
  return { cents, basis, quote: m[0] };
}

/** "Rangers vs Lightning" in the message, kept as the event name so the resolver can narrow by opponent. */
function matchupPhrase(t: string): string | null {
  const m = /\b([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3})\s+(?:vs\.?|v\.?|versus|against|@)\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3})/i.exec(t);
  if (!m) return null;
  // "For New York Rangers vs Tampa Bay at MSG on October 1": the teams, without the words around them (A10).
  const stop = /\s+(?:(?:on|at|in|for|this|next|tonight|tomorrow|please)\b.*|\d.*)$/i;
  const lead = /^(?:(?:for|the|tickets?|seats?|to|at|on|in|about|is|are|of|and|see|watch|game|a|an)\s+)+/i;
  const a = m[1]!.replace(lead, '').replace(stop, '').trim();
  const b = m[2]!.replace(stop, '').trim();
  return a && b ? `${a} vs ${b}` : null;
}

function findEntity(t: string, known: ExtractionInput['knownEntities']): { entity: ExtractionInput['knownEntities'][number]; quote: string } | null {
  const lower = t.toLowerCase();
  let best: { entity: ExtractionInput['knownEntities'][number]; quote: string; idx: number } | null = null;
  for (const e of known) {
    for (const n of [e.name, ...e.aliases]) {
      const idx = lower.indexOf(n.toLowerCase());
      if (idx >= 0 && (!best || idx < best.idx)) best = { entity: e, quote: n, idx };
    }
  }
  return best ? { entity: best.entity, quote: best.quote } : null;
}

// Spans first: "Oct 1-7" must not be read as the single date Oct 1, nor "the first week in October" as the month.
const MONTH_DAY_SRC = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?(?!\\s*(?:-|–|to|through|thru)\\s*\\d)';
const DATE_EXPR = /\b((?:the )?(?:first|1st|second|2nd|third|3rd|fourth|4th|last|final) week (?:of|on|in) (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?|(?:early|beginning of|start of|mid|middle of|late|end of)\s*-?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?\s*(?:-|–|to|through|thru)\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? )?\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s*(?:-|–|to|through|thru)\s*\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?|(?:next|coming) (?:few|couple(?: of)?|\d|two|three|four) weeks|(?:this|next) month|(?:sometime )?(?:in|during|for) (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?: \d{4})?|(?:sometime |later )?(?:this|next) week(?:end)?|(?:this|the) weekend|tonight|today|tomorrow(?: night)?|day after tomorrow|in \d{1,2} days?|(?:this |next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function resolveMonthDay(expr: string, receivedAt: Date): string | null {
  const m = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/i.exec(expr.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3)) + 1;
  const day = Number(m[2]);
  let year = m[3] ? Number(m[3]) : receivedAt.getUTCFullYear();
  if (!m[3] && (month < receivedAt.getUTCMonth() + 1 || (month === receivedAt.getUTCMonth() + 1 && day < receivedAt.getUTCDate()))) year += 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const CITIES: Array<[RegExp, string, string]> = [
  [/\b(brooklyn|barclays)\b/i, 'Brooklyn', 'NY'],
  [/\b(new york|nyc|manhattan|msg|madison square garden|(?:in|near|around) ny)\b/i, 'New York', 'NY'],
  [/\b(philadelphia|philly)\b/i, 'Philadelphia', 'PA'],
  [/\b(los angeles|la\b|inglewood)\b/i, 'Los Angeles', 'CA'],
  [/\b(chicago)\b/i, 'Chicago', 'IL'],
  [/\b(boston)\b/i, 'Boston', 'MA'],
  [/\b(toronto)\b/i, 'Toronto', 'ON'],
  [/\b(london)\b/i, 'London', 'UK'],
];

/** Someone saying no one in the party needs accessible seating: the word "wheelchair" is not a need. */
export const NO_ACCESS_NEED = /\b(neither of us|none of us|no one|nobody|we don'?t|we do not|i don'?t|i do not)\s+(needs?|requires?|uses?)\b[^.;!?]{0,40}\b(wheelchair|accessible|accessibility|ada)\b/i;

/**
 * The date they name, read without a model: "Oct 3", "Monday October 5", "this coming Friday", "knicks fri".
 * `resolvedLocalDate` is set only for one unambiguous day; a month, week or span leaves it null (the resolver uses
 * the window). The pipeline also runs this over the model's reading when the model left the day unresolved
 * (TGQA-R8 S03, S08).
 */
export function readDate(t: string, receivedAt: Date, venueTimeZone: string | null): { dateExpression: string | null; resolvedLocalDate: string | null; ambiguities: string[] } {
  const ambiguities: string[] = [];
  const input = { receivedAt, venueTimeZone };
  // A calendar date anywhere in the message beats a looser phrase before it: in "I'm in New York for the
  // weekend, 2 Rangers tickets Oct 3" the weekend is the trip, and Oct 3 is the game.
  const explicitDay = new RegExp(`\\b(${MONTH_DAY_SRC})\\b`, 'i').exec(t);
  // "knicks fri", "this coming Friday": the day, spelled out for the date reader.
  const FULL: Record<string, string> = { fri: 'friday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', sat: 'saturday', sun: 'sunday', mon: 'monday' };
  const td = t.replace(/\bthis coming\b/gi, 'this').replace(/\b(fri|thurs?|thu|tues?|wed)\b\.?/gi, (m) => FULL[m.replace('.', '').toLowerCase()] ?? m).replace(/\b(this|next|on|for)\s+(sat|sun|mon)\b\.?/gi, (_m, a: string, d: string) => `${a} ${FULL[d.toLowerCase()]}`);
  const dateM = explicitDay ?? DATE_EXPR.exec(td);
  const dateExpression = dateM ? dateM[1]! : null;
  let resolvedLocalDate: string | null = null;
  if (dateExpression) {
    // A span is checked before a single date: "Oct 1-7" names a week, not the 1st.
    const window = dateWindowFor(dateExpression, input.receivedAt, input.venueTimeZone ?? 'America/New_York');
    const md = window ? null : resolveMonthDay(dateExpression, input.receivedAt);
    if (md) resolvedLocalDate = md;
    else if (window) {
      // A named month, week or span narrows the search without picking a day; the resolver uses the window.
    } else {
      const r = resolveRelativeDate(dateExpression, input.receivedAt, input.venueTimeZone);
      if (r.kind === 'resolved') {
        resolvedLocalDate = r.ambiguous ? null : r.localDate;
        if (r.ambiguous) ambiguities.push('date_near_midnight');
      } else ambiguities.push(`date_${r.reason}`);
    }
  }
  return { dateExpression, resolvedLocalDate, ambiguities };
}

export class FixtureExtractor implements Extractor {
  readonly name = 'fixture';
  async extract(input: ExtractionInput): Promise<RequestExtraction> {
    // "Thursday October8", "after7pm", "kids12 and15": read with the spaces put back.
    const t = unglue(input.text);
    const evidence: RequestExtraction['evidence'] = [];
    const ambiguities: string[] = [];
    const ev = (field: string, quote: string | null) => quote && evidence.push({ field, messageId: input.messageId, quote });

    const optOut = classifyOptOutText(t);
    let intent: RequestExtraction['intent'] = 'new_search';
    if (optOut) intent = 'marketing_opt_out';
    else if (/\b(delete|erase|remove) (all )?(of )?my (data|information|account)\b/i.test(t)) intent = 'delete_data';
    else if (/\b(stop|cancel) (the |my )?(watch|monitoring|alerts?|looking)\b/i.test(t)) intent = 'cancel_watch';
    else if (/\b(keep (looking|watching|an eye)|watch (it|this|for)|let me know if|alert me|notify me|please watch|monitor(ing)? (it|this|prices?)|email me (only )?when)\b/i.test(t)) intent = 'watch_request';
    // "Let me know when it goes on sale" is about the event, not its price: no watch, no budget needed.
    const notify = lexiconNotifyAsked(t);
    if (notify && intent === 'watch_request') intent = 'new_search';

    const qty = parseQuantity(t);
    ev('quantity', qty.quote);
    // "Is $106 a good deal?" is a price they saw, not what they will pay: it is the quote, and not a budget.
    // "Worth it? Budget is $200": a price check, but the amount they call a budget is theirs, not the listing's (TGQA-R6 1003).
    const quoted = lexiconPriceCheck(t) && !/\b(?:budget|can spend|spend up to|max(?:imum)?|cap)\b[^.?!$]{0,20}\$\s?\d/i.test(t) ? parseBudget(t) : null;
    const budget = quoted?.cents != null ? { cents: null, basis: null, quote: null } : parseBudget(t);
    if (quoted?.quote) ev('quotedPriceCents', quoted.quote);
    ev('budgetCents', budget.quote);
    if (budget.cents !== null && budget.basis === null) ambiguities.push('budget_basis_unknown');
    // "A few" or "some" tickets is a real doubt about the number, so it is asked rather than assumed to be two.
    if (lexiconVagueQuantity(t) || quantityIsOpenChoice(t)) ambiguities.push('quantity_unclear');

    // Negations first so "anything except X, Y please" resolves to Y (A29).
    const negated: string[] = [];
    for (const e of input.knownEntities) {
      // By any name the customer uses: "anything except the Knicks" names the New York Knicks by nickname.
      const names = [e.name, ...e.aliases].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const re = new RegExp(`\\b(?:anything (?:but|except)|not|no|don'?t want)\\s+(?:the\\s+)?(?:${names})\\b`, 'i');
      if (re.test(t)) negated.push(e.name);
    }
    const ent = findEntity(t, input.knownEntities.filter((e) => !negated.includes(e.name)));
    ev('performerOrTeam', ent?.quote ?? null);

    const date = readDate(t, input.receivedAt, input.venueTimeZone);
    const dateExpression = date.dateExpression;
    ev('dateExpression', dateExpression);
    const resolvedLocalDate = date.resolvedLocalDate;
    ambiguities.push(...date.ambiguities);

    let city: string | null = null;
    let state: string | null = null;
    // A neighbourhood first: "Bushwick, Brooklyn" is Bushwick, and the market follows from it.
    const hood = neighbourhoodFor(t);
    if (hood) {
      city = hood.label.replace(/^the /, '');
      ev('city', hood.match.exec(t)?.[0] ?? hood.label);
    }
    // "1pm NEW YORK time", "11am Los Angeles" name a clock, not where the event is (TGQA-R8 17).
    const tc = t.replace(/\b(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\s+)(?:new york|nyc|los angeles|la|chicago|denver|phoenix|seattle|boston)\b(?:\s+time)?|\b(?:new york|nyc|los angeles|la|chicago|denver|pacific|eastern|central|mountain)\s+time\b/gi, ' ');
    for (const [re, c, s] of hood ? [] : CITIES) {
      const m = re.exec(tc);
      if (m) {
        city = c;
        state = s;
        ev('city', m[0]);
        break;
      }
    }
    // Any other US market the service knows, named as a place ("in Austin", "around Nashville"): the short city list
    // above covers the pilot; without this, "country shows in Austin" was searched in New York (Research 1).
    if (!city && !hood) {
      for (const mk of MARKETS) {
        const hit = mk.match.exec(tc);
        if (hit && /\b(?:in|around|near|to|at|visiting|from|for)\s+(?:the\s+|downtown\s+)?$/i.test(tc.slice(Math.max(0, hit.index - 20), hit.index))) {
          city = mk.label;
          ev('city', hit[0]);
          break;
        }
      }
    }
    // A state, when no city is named: "they're playing in Connecticut".
    if (!city) {
      const sm = /\b(?:in|to|around)\s+(?:the\s+state\s+of\s+)?([a-z]+(?:\s[a-z]+)?)\b/gi;
      for (const m of t.matchAll(sm)) {
        // Names only: two letters ("in or out", "in me") are words far more often than states here.
        const words = m[1]!.split(' ');
        const code = [m[1]!, words[0]!].filter((w) => w.length > 2).map(stateCodeFor).find(Boolean) ?? null;
        if (code && !['NY', 'WA', 'DC'].includes(code)) {
          state = code;
          ev('state', m[0]);
          break;
        }
      }
    }
    // The negation is checked first: "we don't need to sit together" contains "together".
    const together = /\b(don'?t (need|have) to (sit|be) together|split (is )?(ok|fine)|separate seats (are )?(ok|fine))\b/i.test(t) ? false : /\b(together|next to each other|adjacent|side by side)\b/i.test(t) ? true : null;
    ev('togetherRequired', together === null ? null : (/\b(together|next to each other|adjacent|side by side|split|separate)\b/i.exec(t)?.[0] ?? null));
    // A need, said as one: "cannot manage stairs" is step-free access; "neither of us needs wheelchair seating"
    // is no need at all, whatever words follow it.
    const accessMatch = /\b(step[- ]free|no stairs|(?:can(?:no|')?t|cannot|unable to) (?:manage|do|climb|use) (?:the )?stairs|wheelchair|accessible|ada)\b/i.exec(t);
    // Said the way they need it: "one wheelchair space with a companion seat beside it, and a step-free route".
    const accessParts = accessMatch && !NO_ACCESS_NEED.test(t) ? [/wheelchair\s+(?:space|spot|seat)/i.test(t) ? (/companion/i.test(t) ? 'a wheelchair space with a companion seat beside it' : 'a wheelchair space') : /wheelchair|accessible|ada/i.test(accessMatch[0]) ? accessMatch[0] : null, /step[- ]free|no stairs|stairs/i.test(t) ? (/step[- ]free access|access\b[^.?!]{0,20}\bstep[- ]free/i.test(t) ? 'step-free access' : 'a step-free route') : null].filter((x): x is string => !!x) : [];
    const accessibility = accessParts.length ? [accessParts.join(' and ')] : null;
    // A nickname two teams share ("Giants") stays the customer's word: which one is meant is the resolver's call,
    // from the catalog and the market, not whichever happened to be listed first.
    const sharedNickname = !!ent && input.knownEntities.filter((k) => [k.name, ...k.aliases].some((n) => n.toLowerCase() === ent.quote.toLowerCase())).length > 1;
    const performerOrTeam = ent ? (sharedNickname ? ent.quote : ent.entity.name) : null;
    const urls = [...t.matchAll(/https?:\/\/[^\s<>"')]+/gi)].map((m) => m[0]);
    const mustAttend = /\b(must|definitely|have to|can'?t miss|need to) (attend|go|be there|make it)\b/i.test(t)
      ? true
      : /\b(flexible (?:on|about) (?:the )?(?:date|day|game|night|timing|when|going|attending)|not a big deal if|don'?t mind (skipping|missing)|only if (it'?s )?cheap)\b/i.test(t)
        ? false
        : null;
    const risk: RequestExtraction['waitRiskTolerance'] = /\b(happy to (wait|gamble|risk)|fine (to )?wait(ing)?|willing to (wait|risk)|ok(ay)? (to )?wait|(?:can|could) risk missing out)\b/i.test(t) ? 'high' : /\b(don'?t want to risk|rather not risk|lock (it|them) in|secure (them|it) now)\b/i.test(t) ? 'low' : null;
    const forSelf = /\b(for (my|a) (friend|dad|mom|mother|father|sister|brother|boss|colleague|client)|as a gift|gift for)\b/i.test(t) ? false : /\b(for (me|us|myself)|my (wife|husband|partner|kids|family) and (i|me))\b/i.test(t) ? true : null;
    const countryStatement = findResidenceStatement(t);
    // A kind of music is only read when nobody is named: "Kid Rock" is an artist, not a genre.
    // A genre they rule out is not the one they want: "country or Americana, not rock or pop" is country (Research 1).
    const genre = ent ? null : lexiconGenre(t.replace(/\b(?:not|no|nor|never|rather than|instead of|except|other than)\s+(?:any\s+|more\s+)?[a-z&/ -]{1,40}?(?=[,.;:!?]|\s+(?:but|please|thanks|and i|i want|i'?d)\b|$)/gi, ' '));
    if (genre) ev('genreHint', genre.quote);
    const categoryHint = categoryHintFrom(t) ?? (genre ? 'concert' : null);
    // "What's on" with nothing specific named is a browse: answer with options instead of asking which event.
    if (intent === 'new_search' && !ent && (BROWSE_ASK_TEST(t) || categoryHint)) intent = 'browse';

    return EXTRACTION_SCHEMA.parse({
      intent,
      eventName: matchupPhrase(t),
      performerOrTeam,
      city,
      state,
      dateExpression,
      resolvedLocalDate,
      quantity: qty.value,
      budgetCents: budget.cents,
      budgetBasis: budget.basis,
      seatingPreference: /\b(lower (level|bowl)|upper (level|deck)|floor|club|100s|200s|300s|behind the (bench|goal|plate))\b/i.exec(t)?.[0] ?? null,
      togetherRequired: together,
      accessibilityNeeds: accessibility ? accessibility[0] : null,
      alternativesAllowed: /\b(open to (other|alternatives|different)|any (other )?(date|night|game) (works|is fine))\b/i.test(t) ? true : null,
      submittedUrls: urls,
      evidence,
      ambiguities,
      mustAttend,
      waitRiskTolerance: risk,
      decisionDeadline: null,
      splitGroupAllowed: together === false ? true : null,
      forSelf,
      negatedEntities: negated,
      countryStatement,
      categoryHint,
      genreHint: genre?.value ?? null,
      wantsMore: lexiconWantsMore(t) ? true : null,
      resaleAsked: lexiconResaleAsked(t) ? true : null,
      notifyAsked: notify ? true : null,
      quotedPriceCents: quoted?.cents ?? null,
      quotedPriceBasis: quoted?.basis ?? null,
    });
  }
}

/** Fields that must be present before research can start (API_AND_DATA_CONTRACTS §1). */
export function missingMandatoryFields(x: RequestExtraction, opts: { eventResolved: boolean }): string[] {
  const missing: string[] = [];
  if (!opts.eventResolved) missing.push('event');
  if (x.quantity === null) missing.push('quantity');
  if (x.budgetCents !== null && x.budgetBasis === null) missing.push('budget_basis');
  return missing;
}

/** At most three questions, never re-asking what the current revision already established. */
/**
 * Title-cases a name for customer-facing text. Only all-lowercase words are touched, so "NY Rangers" and
 * "Dua Lipa" survive: the brief keeps whatever the customer typed, and only the email is tidied.
 */
export function titleCaseName(name: string): string {
  // A matchup's separator stays lower case: "Rangers vs Lightning", not "Rangers Vs Lightning".
  return name.replace(/\b[a-z][a-z'\u2019-]*/g, (w) => w[0]!.toUpperCase() + w.slice(1)).replace(/\b(Vs|Versus|Against)\b/g, (w) => w.toLowerCase());
}

export function clarificationQuestions(missing: string[], known: RequestExtraction): string[] {
  const q: string[] = [];
  const who = known.performerOrTeam ? titleCaseName(known.performerOrTeam) : null;
  // A name that matches more than one team or artist has to be settled before anything else: asking which
  // date a "Rangers" game is would assume the very thing in doubt, so it replaces the generic event question.
  const nameAmbiguous = missing.includes('performer_ambiguous');
  if (nameAmbiguous) q.push(who ? `First, which ${who} do you mean? There is more than one team or artist by that name. A link to the event settles it.` : 'Which performer or team do you mean? A link to the event settles it.');
  for (const m of missing) {
    if (m === 'event' && !nameAmbiguous) q.push(who ? `Which ${who} date and venue are you looking at? A link works too.` : 'Which event (performer or team, city, and date) are you looking at? A link or screenshot works.');
    if (m === 'event_location_unknown' && !missing.includes('event')) q.push('Which city or venue are you looking at?');
    if (m === 'quantity_unclear' && !missing.includes('quantity')) q.push('How many tickets do you need in total?');
    // A date we could not pin down is asked about explicitly. Guessing which day "tonight" means across a
    // timezone we do not know is how a request ends up bound to the wrong game.
    if (m === 'date_near_midnight') q.push(`Just to confirm the day${known.dateExpression ? ` (you said "${known.dateExpression}")` : ''}: which calendar date do you mean?`);
    // One question about the date, not two ("Which date?" and "Could you give the calendar date?", TGQA-R6 1007).
    if (m === 'date_unsupported_expression' && !missing.includes('event')) q.push(known.dateExpression ? `We weren't sure which date "${known.dateExpression}" means. Could you give the calendar date?` : 'Which date are you looking at?');
    if (m === 'date_venue_timezone_unknown' && !missing.includes('event')) q.push('Which city or venue, and which date? We need the venue to read the date correctly.');
    if (m === 'quantity') q.push(known.togetherRequired === null ? 'How many tickets do you need, and do they need to be together?' : 'How many tickets do you need?');
    if (m === 'budget_basis' || m === 'budget_basis_unknown') q.push(`Is your budget of $${((known.budgetCents ?? 0) / 100).toFixed(0)} per ticket or for everyone combined?`);
    if (m === 'country') q.push('Quick check so we send the right options: are you based in the US?');
    if (m === 'wait_risk_tolerance') q.push('If prices might drop but seats could disappear, would you rather lock in now or wait a bit?');
    if (m === 'decision_deadline') q.push('By when do you need to decide?');
  }
  return q.slice(0, 3);
}
