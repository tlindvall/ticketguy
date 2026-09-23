import { z } from 'zod';
import { RequestExtractionSchema, type RequestExtraction } from '@/lib/domain/types';
import { monthWindowFor, resolveRelativeDate } from '@/lib/domain/dates';
import { classifyOptOutText } from '@/lib/domain/suppression';

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
const COUPLE = /\b(?:my (?:wife|husband|partner|girlfriend|boyfriend) and (?:i|me)|(?:me|myself) and my (?:wife|husband|partner|girlfriend|boyfriend))\b/i;

function parseQuantity(t: string): { value: number | null; quote: string | null } {
  const m = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|a|single|pair|couple)\s*(?:of\s+us|people|tickets?|seats?|tix|adults?|friends?)\b/i.exec(t) ?? /\b(?:party|group|family|household|crew)\s+of\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(t) ?? /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:together)\b/i.exec(t);
  if (!m) {
    const couple = COUPLE.exec(t);
    return couple ? { value: 2, quote: couple[0] } : { value: null, quote: null };
  }
  const raw = m[1]!.toLowerCase();
  const v = NUM_WORDS[raw] ?? Number(raw);
  return Number.isFinite(v) && v > 0 ? { value: v, quote: m[0] } : { value: null, quote: null };
}

function parseBudget(t: string): { cents: number | null; basis: 'per_ticket' | 'whole_party' | null; quote: string | null } {
  const m = /(?:under|below|max(?:imum)?|budget(?: is| of)?|up to|no more than|around|about|<|≤)?\s*\$\s?(\d{1,5}(?:[.,]\d{2})?)\s*(total|all[- ]in|for (?:all|both|the (?:two|three|four|five|six|group|pair))|combined|altogether|each|per (?:ticket|person|seat)|a (?:ticket|seat|person)|apiece|pp)?/i.exec(t);
  if (!m) return { cents: null, basis: null, quote: null };
  const cents = Math.round(Number(m[1]!.replace(',', '.')) * 100);
  const q = (m[2] ?? '').toLowerCase();
  let basis: 'per_ticket' | 'whole_party' | null = null;
  if (/total|all|combined|altogether|for/.test(q)) basis = 'whole_party';
  else if (/each|per|apiece|pp|a /.test(q)) basis = 'per_ticket';
  return { cents, basis, quote: m[0] };
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

const DATE_EXPR = /\b((?:sometime )?(?:in|during|for) (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?: \d{4})?|tonight|today|tomorrow(?: night)?|day after tomorrow|in \d{1,2} days?|(?:this |next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)\b/i;
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
  [/\b(new york|nyc|manhattan|brooklyn|msg|madison square garden|barclays)\b/i, 'New York', 'NY'],
  [/\b(los angeles|la\b|inglewood)\b/i, 'Los Angeles', 'CA'],
  [/\b(chicago)\b/i, 'Chicago', 'IL'],
  [/\b(boston)\b/i, 'Boston', 'MA'],
  [/\b(toronto)\b/i, 'Toronto', 'ON'],
  [/\b(london)\b/i, 'London', 'UK'],
];

export class FixtureExtractor implements Extractor {
  readonly name = 'fixture';
  async extract(input: ExtractionInput): Promise<RequestExtraction> {
    const t = input.text;
    const evidence: RequestExtraction['evidence'] = [];
    const ambiguities: string[] = [];
    const ev = (field: string, quote: string | null) => quote && evidence.push({ field, messageId: input.messageId, quote });

    const optOut = classifyOptOutText(t);
    let intent: RequestExtraction['intent'] = 'new_search';
    if (optOut) intent = 'marketing_opt_out';
    else if (/\b(delete|erase|remove) (all )?(of )?my (data|information|account)\b/i.test(t)) intent = 'delete_data';
    else if (/\b(stop|cancel) (the |my )?(watch|monitoring|alerts?|looking)\b/i.test(t)) intent = 'cancel_watch';
    else if (/\b(keep (looking|watching|an eye)|watch (it|this|for)|let me know if|alert me|notify me)\b/i.test(t)) intent = 'watch_request';

    const qty = parseQuantity(t);
    ev('quantity', qty.quote);
    const budget = parseBudget(t);
    ev('budgetCents', budget.quote);
    if (budget.cents !== null && budget.basis === null) ambiguities.push('budget_basis_unknown');

    // Negations first so "anything except X, Y please" resolves to Y (A29).
    const negated: string[] = [];
    for (const e of input.knownEntities) {
      const re = new RegExp(`\\b(?:anything (?:but|except)|not|no|don'?t want)\\s+(?:the\\s+)?${e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(t)) negated.push(e.name);
    }
    const ent = findEntity(t, input.knownEntities.filter((e) => !negated.includes(e.name)));
    ev('performerOrTeam', ent?.quote ?? null);

    const dateM = DATE_EXPR.exec(t);
    const dateExpression = dateM ? dateM[1]! : null;
    ev('dateExpression', dateExpression);
    let resolvedLocalDate: string | null = null;
    if (dateExpression) {
      const md = resolveMonthDay(dateExpression, input.receivedAt);
      if (md) resolvedLocalDate = md;
      else if (monthWindowFor(dateExpression, input.receivedAt)) {
        // A named month narrows the search without picking a day; the resolver uses the window.
      } else {
        const r = resolveRelativeDate(dateExpression, input.receivedAt, input.venueTimeZone);
        if (r.kind === 'resolved') {
          resolvedLocalDate = r.ambiguous ? null : r.localDate;
          if (r.ambiguous) ambiguities.push('date_near_midnight');
        } else ambiguities.push(`date_${r.reason}`);
      }
    }

    let city: string | null = null;
    let state: string | null = null;
    for (const [re, c, s] of CITIES) {
      const m = re.exec(t);
      if (m) {
        city = c;
        state = s;
        ev('city', m[0]);
        break;
      }
    }
    const together = /\b(together|next to each other|adjacent|side by side)\b/i.test(t) ? true : /\b(don'?t (need|have) to (sit|be) together|split (is )?(ok|fine)|separate seats (are )?(ok|fine))\b/i.test(t) ? false : null;
    ev('togetherRequired', together === null ? null : (/\b(together|next to each other|adjacent|side by side|split|separate)\b/i.exec(t)?.[0] ?? null));
    const accessibility = /\b(wheelchair|accessible|ada)\b/i.exec(t);
    const performerOrTeam = ent ? ent.entity.name : null;
    const urls = [...t.matchAll(/https?:\/\/[^\s<>"')]+/gi)].map((m) => m[0]);
    const mustAttend = /\b(must|definitely|have to|can'?t miss|need to) (attend|go|be there|make it)\b/i.test(t)
      ? true
      : /\b(flexible (?:on|about) (?:the )?(?:date|day|game|night|timing|when|going|attending)|not a big deal if|don'?t mind (skipping|missing)|only if (it'?s )?cheap)\b/i.test(t)
        ? false
        : null;
    const risk: RequestExtraction['waitRiskTolerance'] = /\b(happy to (wait|gamble|risk)|fine (to )?wait(ing)?|willing to (wait|risk)|ok(ay)? (to )?wait)\b/i.test(t) ? 'high' : /\b(don'?t want to risk|rather not risk|lock (it|them) in|secure (them|it) now)\b/i.test(t) ? 'low' : null;
    const forSelf = /\b(for (my|a) (friend|dad|mom|mother|father|sister|brother|boss|colleague|client)|as a gift|gift for)\b/i.test(t) ? false : /\b(for (me|us|myself)|my (wife|husband|partner|kids|family) and (i|me))\b/i.test(t) ? true : null;
    const countryStatement = /\b(i(?:'m| am) (?:in|from|based in) (?:the )?(us|usa|united states|uk|canada|[a-z]+))\b/i.exec(t)?.[0] ?? null;

    return EXTRACTION_SCHEMA.parse({
      intent,
      eventName: null,
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
export function clarificationQuestions(missing: string[], known: RequestExtraction): string[] {
  const q: string[] = [];
  for (const m of missing) {
    if (m === 'event') q.push(known.performerOrTeam ? `Which ${known.performerOrTeam} date and venue are you looking at? A link works too.` : 'Which event (performer or team, city, and date) are you looking at? A link or screenshot works.');
    if (m === 'quantity') q.push('How many tickets do you need, and do they need to be together?');
    if (m === 'budget_basis') q.push(`Is your budget of $${((known.budgetCents ?? 0) / 100).toFixed(0)} per ticket or for everyone combined?`);
    if (m === 'country') q.push('Quick check so we send the right options: are you based in the US?');
    if (m === 'wait_risk_tolerance') q.push('If prices might drop but seats could disappear, would you rather lock in now or wait a bit?');
    if (m === 'decision_deadline') q.push('By when do you need to decide?');
  }
  return q.slice(0, 3);
}
