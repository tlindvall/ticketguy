import type { CategoryHint } from '@/lib/domain/browse';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * The phrasebook: how customers say things, and what each phrase means to the concierge.
 *
 * One table, three uses:
 *  - the rules extractor reads `pattern` (src/lib/ai/extraction.ts), so fixture and fallback parsing agree;
 *  - the model is taught the entries marked `teachModel` (src/lib/ai/model-client.ts), as short examples;
 *  - docs/LEXICON.md is generated from it (`pnpm lexicon:doc`) for people to read and extend.
 *
 * Every entry carries examples, and tests/unit/lexicon.test.ts runs each one through the rules extractor, so
 * an entry that stops meaning what it says fails the build instead of failing a customer. To add a phrase:
 * add an entry (or a phrase to one), give it at least one example, run the tests, regenerate the doc.
 */

export type RequestType = 'find' | 'browse' | 'watch' | 'change' | 'stop' | 'any';
export type LexiconCategory = CategoryHint | 'any';

export type LexiconEntry = {
  id: string;
  /** What the phrase sets. */
  field: 'intent' | 'categoryHint' | 'quantity' | 'quantity_unclear' | 'budgetBasis' | 'togetherRequired' | 'dateExpression' | 'city';
  /** The meaning, in words, for people. */
  meaning: string;
  /** The value it sets (for fields with a fixed value). */
  value?: string | number | boolean;
  /** How customers say it — human-readable, shown in the doc and taught to the model. */
  phrases: string[];
  /** The rules extractor's matcher. Case-insensitive. */
  pattern: RegExp;
  categories: LexiconCategory[];
  requestTypes: RequestType[];
  /** Taught to the model as an example in its instructions. */
  teachModel?: boolean;
  /** Real-sounding messages and the fields they must produce. */
  examples: Array<{ text: string; expect: Partial<RequestExtraction> }>;
  note?: string;
};

export const LEXICON: LexiconEntry[] = [
  // ── What kind of request ───────────────────────────────────────────────────────────────────────────
  {
    id: 'intent.browse',
    field: 'intent',
    value: 'browse',
    meaning: 'Asks what is on, with nothing specific named — answered with a short list, not questions.',
    phrases: ["what's on", "what's happening", 'what options do I have', 'what can I see', 'any good shows', 'anything fun on', 'recommendations', 'things to do'],
    pattern: /\b(what(?:'s| is)? on|what(?:'s| is) happening|what (?:options|choices) (?:do i|are there)|what can (?:i|we) (?:see|go to)|what should (?:i|we) (?:see|go to)|any (?:good )?(?:shows|gigs|concerts|games)|anything (?:good|fun) (?:on|happening)|recommend(?:ations?)?|suggest(?:ions?)?|things to (?:do|see))\b/i,
    categories: ['any'],
    requestTypes: ['browse'],
    teachModel: true,
    examples: [
      { text: "I'm coming to New York and want to see some music gigs during the first week on october. What options do I have?", expect: { intent: 'browse', categoryHint: 'concert', performerOrTeam: null } },
      { text: "What's on at MSG next weekend?", expect: { intent: 'browse' } },
    ],
  },
  {
    id: 'intent.watch',
    field: 'intent',
    value: 'watch_request',
    meaning: 'Wants to be told when something changes, not a one-off answer.',
    phrases: ['keep an eye', 'keep looking', 'let me know if', 'alert me', 'notify me', 'watch for'],
    pattern: /\b(keep (looking|watching|an eye)|watch (it|this|for)|let me know if|alert me|notify me)\b/i,
    categories: ['any'],
    requestTypes: ['watch'],
    examples: [{ text: 'Knicks on October 24, 2 tickets, $300 total. Let me know if it drops.', expect: { intent: 'watch_request' } }],
  },
  {
    id: 'intent.cancel_watch',
    field: 'intent',
    value: 'cancel_watch',
    meaning: 'Stop a watch that is running.',
    phrases: ['stop the watch', 'cancel my alerts', 'stop looking'],
    pattern: /\b(stop|cancel) (the |my )?(watch|monitoring|alerts?|looking)\b/i,
    categories: ['any'],
    requestTypes: ['stop'],
    examples: [{ text: 'Please stop the watch, we bought tickets.', expect: { intent: 'cancel_watch' } }],
  },

  // ── What kind of event (no performer or team named) ──────────────────────────────────────────────────
  {
    id: 'category.nhl',
    field: 'categoryHint',
    value: 'nhl',
    meaning: 'Hockey.',
    phrases: ['hockey', 'NHL', 'a hockey game'],
    pattern: /\b(nhl|hockey)\b/i,
    categories: ['nhl'],
    requestTypes: ['browse', 'find'],
    teachModel: true,
    examples: [{ text: 'Any hockey games coming up?', expect: { categoryHint: 'nhl', intent: 'browse' } }],
  },
  {
    id: 'category.wnba',
    field: 'categoryHint',
    value: 'wnba',
    meaning: "Women's pro basketball. Checked before 'basketball'.",
    phrases: ['WNBA'],
    pattern: /\b(wnba)\b/i,
    categories: ['wnba'],
    requestTypes: ['browse', 'find'],
    examples: [{ text: 'Any WNBA games this month?', expect: { categoryHint: 'wnba' } }],
  },
  {
    id: 'category.nba',
    field: 'categoryHint',
    value: 'nba',
    meaning: 'Basketball.',
    phrases: ['basketball', 'NBA', 'a basketball game'],
    pattern: /\b(nba|basketball)\b/i,
    categories: ['nba'],
    requestTypes: ['browse', 'find'],
    teachModel: true,
    examples: [{ text: 'Want to catch a basketball game next week, what is on?', expect: { categoryHint: 'nba', intent: 'browse' } }],
  },
  {
    id: 'category.mlb',
    field: 'categoryHint',
    value: 'mlb',
    meaning: 'Baseball.',
    phrases: ['baseball', 'MLB', 'a ball game'],
    pattern: /\b(mlb|baseball|ball ?game)\b/i,
    categories: ['mlb'],
    requestTypes: ['browse', 'find'],
    teachModel: true,
    examples: [{ text: 'Any baseball on this weekend?', expect: { categoryHint: 'mlb' } }],
  },
  {
    id: 'category.concert',
    field: 'categoryHint',
    value: 'concert',
    meaning: 'Live music of any kind.',
    phrases: ['gig', 'gigs', 'concert', 'live music', 'music', 'a band', 'a DJ set', 'festival'],
    pattern: /\b(gigs?|concerts?|live music|music|bands?|dj sets?|festivals?)\b/i,
    categories: ['concert'],
    requestTypes: ['browse', 'find'],
    teachModel: true,
    examples: [
      { text: 'Any good gigs in Brooklyn in early October?', expect: { categoryHint: 'concert', intent: 'browse' } },
      { text: 'Looking for live music next weekend', expect: { categoryHint: 'concert' } },
    ],
  },
  {
    id: 'category.theater',
    field: 'categoryHint',
    value: 'theater',
    meaning: 'Broadway and plays — outside the pilot, so the customer is told plainly.',
    phrases: ['Broadway', 'a musical', 'a play', 'theater', 'theatre'],
    pattern: /\b(broadway|musicals?|theat(?:er|re)|plays?)\b/i,
    categories: ['theater'],
    requestTypes: ['browse', 'find'],
    teachModel: true,
    examples: [{ text: 'Any good Broadway musicals on next week?', expect: { categoryHint: 'theater' } }],
  },
  {
    id: 'category.comedy',
    field: 'categoryHint',
    value: 'comedy',
    meaning: 'Stand-up — outside the pilot.',
    phrases: ['comedy', 'stand-up', 'a comedian'],
    pattern: /\b(comedy|stand-?up|comedians?)\b/i,
    categories: ['comedy'],
    requestTypes: ['browse', 'find'],
    examples: [{ text: 'Any stand-up shows this weekend?', expect: { categoryHint: 'comedy' } }],
  },
  {
    id: 'category.sports',
    field: 'categoryHint',
    value: 'sports',
    meaning: 'A game of any sport. Checked last, so "a hockey game" stays hockey.',
    phrases: ['a game', 'sports', 'a match'],
    pattern: /\b(sports?|games?|matches)\b/i,
    categories: ['sports'],
    requestTypes: ['browse', 'find'],
    teachModel: true,
    examples: [{ text: 'What games are on this weekend?', expect: { categoryHint: 'sports', intent: 'browse' } }],
    note: '"Show" on its own is deliberately unread: it is a concert, a musical or a comedy set.',
  },

  // ── How many ─────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'quantity.just_me',
    field: 'quantity',
    value: 1,
    meaning: 'One ticket.',
    phrases: ['just me', 'only me', 'just myself', 'going solo', 'by myself'],
    pattern: /\b(just (?:me|myself)|only me|going solo|by myself|on my own)\b/i,
    categories: ['any'],
    requestTypes: ['find', 'change'],
    teachModel: true,
    examples: [{ text: 'Rangers on Oct 3, just me.', expect: { quantity: 1 } }],
  },
  {
    id: 'quantity.pair',
    field: 'quantity',
    value: 2,
    meaning: 'Two tickets.',
    phrases: ['me and my wife / husband / partner / friend / son / daughter / dad / mum', 'my wife and I', 'the two of us', 'a pair', 'both of us'],
    pattern: /\b((?:me|myself) and my (?:wife|husband|partner|girlfriend|boyfriend|friend|mate|son|daughter|dad|father|mom|mum|mother|brother|sister|kid)|my (?:wife|husband|partner|girlfriend|boyfriend|friend|son|daughter|dad|mom|mum) and (?:i|me)|the two of us|both of us|a pair of (?:tickets|seats))\b/i,
    categories: ['any'],
    requestTypes: ['find', 'change'],
    teachModel: true,
    examples: [
      { text: 'Knicks on October 24 for me and my son.', expect: { quantity: 2 } },
      { text: 'Rangers on Oct 3 for the two of us.', expect: { quantity: 2 } },
    ],
  },
  {
    id: 'quantity.group',
    field: 'quantity',
    meaning: 'A stated party size.',
    phrases: ['party of 4', 'family of five', 'four of us', 'group of 6', '4 people'],
    pattern: /\b(?:party|group|family|household|crew)\s+of\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b|\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+of\s+us\b/i,
    categories: ['any'],
    requestTypes: ['find', 'change'],
    examples: [{ text: 'Rangers on Oct 3 for a family of four.', expect: { quantity: 4 } }],
  },
  {
    id: 'quantity.vague',
    field: 'quantity_unclear',
    value: true,
    meaning: 'A real doubt about the number — asked, never assumed to be two.',
    phrases: ['a few tickets', 'some seats', 'several tickets', 'a group of us', 'a bunch of tickets'],
    pattern: /\b(a few|few|some|several|a bunch of|a group of|a handful of)\s+(?:\w+\s+)?(tickets?|seats?)\b/i,
    categories: ['any'],
    requestTypes: ['find'],
    teachModel: true,
    examples: [{ text: 'A few tickets for the Rangers on Oct 3.', expect: { ambiguities: ['quantity_unclear'] } }],
  },

  // ── Budget basis ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'budget.per_ticket',
    field: 'budgetBasis',
    value: 'per_ticket',
    meaning: 'The amount is for each ticket.',
    phrases: ['$150 each', 'per ticket', 'per person', 'a ticket', 'apiece', 'pp'],
    pattern: /\$\s?\d[\d,.]*\s*(each|per (?:ticket|person|seat)|a (?:ticket|seat|person)|apiece|pp)\b/i,
    categories: ['any'],
    requestTypes: ['find', 'change'],
    teachModel: true,
    examples: [{ text: 'Knicks next weekend, 4 seats together, $150 each', expect: { budgetBasis: 'per_ticket', budgetCents: 15000, quantity: 4 } }],
  },
  {
    id: 'budget.total',
    field: 'budgetBasis',
    value: 'whole_party',
    meaning: 'The amount is for everyone together. A bare amount is read this way too, and the reply says so.',
    phrases: ['$300 total', 'all in', 'for both', 'for all of us', 'combined', 'altogether'],
    pattern: /\$\s?\d[\d,.]*\s*(total|all[- ]in|for (?:all|both|the (?:two|three|four|five|six|group|pair))|combined|altogether)\b/i,
    categories: ['any'],
    requestTypes: ['find', 'change'],
    teachModel: true,
    examples: [{ text: 'Two tickets for the Rangers on Oct 3, $300 total.', expect: { budgetBasis: 'whole_party', budgetCents: 30000 } }],
  },

  // ── Seats ────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'seats.together',
    field: 'togetherRequired',
    value: true,
    meaning: 'Seats must be next to each other.',
    phrases: ['together', 'next to each other', 'side by side', 'adjacent'],
    pattern: /\b(together|next to each other|adjacent|side by side)\b/i,
    categories: ['any'],
    requestTypes: ['find', 'change'],
    examples: [{ text: 'Two Rangers tickets on Oct 3, together please.', expect: { togetherRequired: true } }],
  },
  {
    id: 'seats.split_ok',
    field: 'togetherRequired',
    value: false,
    meaning: 'Seats may be apart.',
    phrases: ["don't need to sit together", 'split is fine', 'separate seats are ok'],
    pattern: /\b(don'?t (need|have) to (sit|be) together|split (is )?(ok|fine)|separate seats (are )?(ok|fine))\b/i,
    categories: ['any'],
    requestTypes: ['find', 'change'],
    examples: [{ text: "Four Rangers tickets on Oct 3, we don't need to sit together.", expect: { togetherRequired: false } }],
  },

  // ── When ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'date.span',
    field: 'dateExpression',
    meaning: 'A span of days, not one date — narrows the search without picking a day (src/lib/domain/dates.ts).',
    phrases: ['first week of October (also "on"/"in")', 'early / mid / late October', 'end of October', 'Oct 1-7', '3rd - 9th Oct', 'next few weeks', 'next 2 weeks', 'this month', 'next month', 'this week', 'next weekend', 'in October'],
    pattern: /\b((?:first|1st|second|2nd|third|3rd|fourth|4th|last|final) week (?:of|on|in)|early|mid|late|end of|next (?:few|couple|\d) weeks|(?:this|next) (?:week|weekend|month)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\s*(?:-|–|to|through)\s*\d{1,2})/i,
    categories: ['any'],
    requestTypes: ['find', 'browse'],
    teachModel: true,
    examples: [
      { text: 'Rangers tickets in early October', expect: { dateExpression: 'early October', resolvedLocalDate: null } },
      { text: 'Knicks, 2 tickets, oct 1-7', expect: { resolvedLocalDate: null } },
    ],
  },

  // ── Where ────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'place.new_york',
    field: 'city',
    value: 'New York',
    meaning: 'The pilot market, however it is named.',
    phrases: ['New York', 'NYC', 'Manhattan', 'Brooklyn', 'MSG', 'Madison Square Garden', 'Barclays'],
    pattern: /\b(new york|nyc|manhattan|brooklyn|msg|madison square garden|barclays)\b/i,
    categories: ['any'],
    requestTypes: ['find', 'browse'],
    examples: [{ text: 'What concerts are on in NYC next week?', expect: { city: 'New York' } }],
  },
];

export function entriesFor(field: LexiconEntry['field']): LexiconEntry[] {
  return LEXICON.filter((e) => e.field === field);
}

/** The first category entry whose pattern matches, in table order (so "hockey game" is hockey, not "a game"). */
export function lexiconCategory(text: string): CategoryHint | null {
  for (const e of entriesFor('categoryHint')) if (e.pattern.test(text)) return e.value as CategoryHint;
  return null;
}

export function lexiconBrowseAsk(text: string): boolean {
  return LEXICON.find((e) => e.id === 'intent.browse')!.pattern.test(text);
}

/** A fixed-value quantity phrase ("just me", "me and my son"), or a stated group size. */
export function lexiconQuantity(text: string): { value: number; quote: string } | null {
  for (const e of entriesFor('quantity')) {
    const m = e.pattern.exec(text);
    if (!m) continue;
    if (typeof e.value === 'number') return { value: e.value, quote: m[0] };
    const raw = (m[1] ?? m[2] ?? '').toLowerCase();
    const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const v = words[raw] ?? Number(raw);
    if (Number.isFinite(v) && v > 0) return { value: v, quote: m[0] };
  }
  return null;
}

export function lexiconVagueQuantity(text: string): boolean {
  return entriesFor('quantity_unclear').some((e) => e.pattern.test(text));
}

/** The model's phrasebook: one line per taught entry. */
export function modelPhrasebook(): string {
  const lines = LEXICON.filter((e) => e.teachModel).map((e) => {
    const set = e.field === 'quantity_unclear' ? 'add "quantity_unclear" to ambiguities' : e.value !== undefined ? `${e.field}=${JSON.stringify(e.value)}` : e.field;
    return `- ${e.phrases.slice(0, 5).map((p) => `"${p}"`).join(', ')} → ${set}`;
  });
  return `Phrasebook (how customers say things):\n${lines.join('\n')}`;
}
