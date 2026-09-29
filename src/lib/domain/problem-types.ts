import type { RequestExtraction } from './types';

/**
 * What a buyer needed help with, tagged per request so the pilot can say which problems Ticket Guy is asked
 * about and which it actually helps with. Tags come from what the customer said and sent, never from our reply.
 * A request can carry several; they accumulate over the conversation.
 */
export const PROBLEM_TYPES = [
  'price_check', // "is this a good price?", a price or listing sent to judge
  'buy_or_wait', // "should I buy now or hold off?"
  'find_options', // "find me tickets", no listing of their own yet
  'compare_sellers', // "is resale cheaper?", "which site?"
  'group_seats', // three or more, or seats that must be together
  'accessibility', // accessible seating needed
  'delivery_timing', // when tickets arrive, travel, transfer
  'trust_or_scam', // "is this legit?", "is this seller safe?"
  'seat_view', // "is this a good view?", obstructed, which section
  'vip_or_extras', // VIP packages, perks, what's included
  'browse', // "what's on?"
  'event_alert', // "tell me when it goes on sale / there's a date"
  'price_watch', // "keep an eye on prices"
] as const;
export type ProblemType = (typeof PROBLEM_TYPES)[number];

const WORDS: Array<[ProblemType, RegExp]> = [
  ['buy_or_wait', /\b(buy now|hold off|wait (?:until|till|for|closer|a bit)|should i (?:buy|wait)|good time to buy|now or later|buy or wait|will (?:prices|they) (?:drop|go down)|prices? (?:drop|go down))\b/i],
  ['price_check', /\b(good (?:price|deal)|fair price|worth it|overpriced|rip[- ]?off|too much|reasonable price)\b/i],
  ['compare_sellers', /\b(compare|cheaper (?:on|at|elsewhere)|which (?:site|seller)|stubhub or|vivid or|seatgeek or|best price|cheapest)\b/i],
  ['delivery_timing', /\b(deliver(?:y|ed)?|transfer(?:red)?|when (?:will|do) i get|arrive|flight|flying|driving in|travel(?:ling)?|in hand)\b/i],
  ['trust_or_scam', /\b(legit|scam|fake|safe to buy|trust(?:worthy)?|is this real|fraud|counterfeit)\b/i],
  ['seat_view', /\b(view|obstructed|good seats?|which section|sightline|behind the stage|side stage)\b/i],
  ['vip_or_extras', /\b(vip|meet (?:and|&) greet|soundcheck|package|lounge|club access|hospitality|parking pass)\b/i],
];

export function problemTypesFor(x: RequestExtraction, text: string, sent: { listing: boolean; link: boolean }): ProblemType[] {
  const tags = new Set<ProblemType>();
  if (x.quotedPriceCents != null || sent.listing || sent.link) tags.add('price_check');
  if (x.intent === 'browse') tags.add('browse');
  if (x.intent === 'watch_request') tags.add('price_watch');
  if (x.notifyAsked) tags.add('event_alert');
  if (x.resaleAsked) tags.add('compare_sellers');
  if ((x.quantity ?? 0) >= 3 || x.togetherRequired) tags.add('group_seats');
  if (x.accessibilityNeeds) tags.add('accessibility');
  const said = text.replace(/[’‘]/g, "'");
  for (const [tag, re] of WORDS) if (re.test(said)) tags.add(tag);
  if (!tags.has('price_check') && !tags.has('browse') && !tags.has('event_alert') && x.intent === 'new_search' && (x.performerOrTeam || x.eventName)) tags.add('find_options');
  return PROBLEM_TYPES.filter((t) => tags.has(t));
}
