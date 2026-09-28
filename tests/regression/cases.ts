import type { RequestExtraction } from '@/lib/domain/types';
import type { RequestType } from '@/lib/lexicon/lexicon';

/**
 * Fifty real-sounding requests and what each must produce. Two runners read this file:
 *  - tests/acceptance/regression.test.ts runs every case through the pipeline with the rules extractor on
 *    every test run (free, deterministic, against the fixture world: Rangers Oct 3 vs Islanders and Oct 15,
 *    Knicks Oct 24 at MSG, Dua Lipa on file with nothing scheduled, Leafs in Toronto; "now" is Tue Sep 22 2026);
 *  - scripts/eval-extraction-cases.ts runs the `brief` expectations through the configured model on demand
 *    (it costs money), so a model or prompt change is checked against the same phrasings.
 *
 * `brief` holds only facts a correct reader must get from the words; `reply` is how the concierge answers.
 * Every case exists because a phrasing like it went wrong once, or is the obvious way a customer writes.
 */
export type RegressionCase = {
  id: string;
  type: RequestType;
  text: string;
  brief?: Partial<RequestExtraction>;
  reply?: { state?: string; sends?: boolean; contains?: string[]; notContains?: string[] };
};

const ASKS_HOW_MANY = 'How many tickets do you need';
const ASKS_BASIS = 'per ticket or for everyone combined';

export const REGRESSION_CASES: RegressionCase[] = [
  // ── One named event ──────────────────────────────────────────────────────────────────────────────────
  { id: 'find.plain', type: 'find', text: 'Two tickets for the Rangers on Oct 3, $300 total.', brief: { quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party' }, reply: { contains: ['checking options for New York Rangers vs. New York Islanders'] } },
  { id: 'find.matchup', type: 'find', text: 'Rangers vs Islanders, 2 tickets, Oct 3', brief: { quantity: 2 }, reply: { contains: ['New York Rangers vs. New York Islanders'] } },
  { id: 'find.per_ticket', type: 'find', text: 'Need 4 Knicks tickets for October 24, $150 each, together', brief: { quantity: 4, budgetCents: 15000, budgetBasis: 'per_ticket', togetherRequired: true }, reply: { contains: ['New York Knicks vs. Fixture Opponent'], notContains: [ASKS_BASIS, ASKS_HOW_MANY] } },
  { id: 'find.family_phrase', type: 'find', text: 'Knicks game on October 24 for me and my son', brief: { quantity: 2 }, reply: { contains: ['New York Knicks vs. Fixture Opponent'], notContains: ["I've assumed two tickets"] } },
  { id: 'find.slang', type: 'find', text: 'hey can u get me 2 rangers tix oct 3rd', brief: { quantity: 2 }, reply: { contains: ['New York Rangers vs. New York Islanders'] } },
  { id: 'find.caps', type: 'find', text: 'RANGERS OCT 3 TWO TICKETS', brief: { quantity: 2 }, reply: { contains: ['New York Rangers vs. New York Islanders'] } },
  { id: 'find.question', type: 'find', text: 'Can you find me two Knicks tickets for Oct 24? Budget is $200 each.', brief: { quantity: 2, budgetCents: 20000, budgetBasis: 'per_ticket' }, reply: { contains: ['New York Knicks'] } },
  { id: 'find.next_week', type: 'find', text: 'Rangers next week, 2 tickets', brief: { quantity: 2, dateExpression: 'next week' }, reply: { contains: ['New York Rangers vs. New York Islanders'] } },

  // ── Assume and say ───────────────────────────────────────────────────────────────────────────────────
  { id: 'assume.quantity', type: 'find', text: 'Rangers tickets on Oct 3 please.', reply: { contains: ["I've assumed two tickets — just tell me if you need a different number."], notContains: [ASKS_HOW_MANY] } },
  { id: 'assume.budget', type: 'find', text: 'Knicks Oct 24, 2 tickets, around $300', brief: { budgetCents: 30000 }, reply: { contains: ["I've read $300 as the total for both — tell me if you meant per ticket."], notContains: [ASKS_BASIS] } },
  { id: 'assume.nothing_for_one', type: 'find', text: 'Rangers Oct 3, just me, $100', brief: { quantity: 1, budgetCents: 10000 }, reply: { notContains: ["I've assumed", "I've read"] } },
  { id: 'assume.under', type: 'find', text: 'Rangers on Oct 3, lower bowl, 2 seats, under $500', brief: { quantity: 2, budgetCents: 50000 }, reply: { contains: ["I've read $500 as the total for both"] } },
  { id: 'vague.few', type: 'find', text: 'A few tickets for the Rangers on Oct 3.', reply: { state: 'needs_clarification', contains: [ASKS_HOW_MANY], notContains: ["I've assumed two tickets"] } },
  { id: 'vague.some', type: 'find', text: 'Some seats for the Knicks on October 24 please', reply: { state: 'needs_clarification', notContains: ["I've assumed two tickets"] } },

  // ── Which game ───────────────────────────────────────────────────────────────────────────────────────
  { id: 'ambiguous.month', type: 'find', text: 'Two Rangers tickets in October', reply: { state: 'needs_clarification', contains: ['Which game: Sat, Oct 3', 'Thu, Oct 15'] } },
  { id: 'nomatch.opponent', type: 'find', text: 'Rangers vs Lightning on Oct 3, 2 tickets', reply: { state: 'needs_clarification', contains: ["We don't have a scheduled"], notContains: ['Islanders'] } },
  { id: 'nomatch.performer', type: 'find', text: '2 tickets for Dua Lipa in October, $500 total', reply: { state: 'needs_clarification', contains: ["We don't have a scheduled Dua Lipa event"] } },

  // ── Date spans ───────────────────────────────────────────────────────────────────────────────────────
  { id: 'date.first_week', type: 'find', text: '2 Rangers tickets the first week of October', brief: { resolvedLocalDate: null }, reply: { contains: ['New York Rangers vs. New York Islanders'] } },
  { id: 'date.first_week_typo', type: 'find', text: '2 Rangers tickets the first week on october', reply: { contains: ['New York Rangers vs. New York Islanders'], notContains: ['calendar date'] } },
  { id: 'date.mid', type: 'find', text: '2 Rangers tickets mid-October', reply: { contains: ['Fixture Opponent (regular season)'] } },
  { id: 'date.late', type: 'find', text: '2 Knicks tickets late October', reply: { contains: ['New York Knicks vs. Fixture Opponent'] } },
  { id: 'date.range', type: 'find', text: 'Rangers, 2 tickets, oct 1-7', brief: { resolvedLocalDate: null }, reply: { contains: ['New York Rangers vs. New York Islanders'] } },
  { id: 'date.end_of', type: 'find', text: 'Two tickets for the Knicks at the end of October', reply: { contains: ['New York Knicks vs. Fixture Opponent'] } },

  // ── What's on ────────────────────────────────────────────────────────────────────────────────────────
  { id: 'browse.gigs_original', type: 'browse', text: "Hello -\n\nI'm coming to New York and want to see some music gigs during the first week on october. What options do I have?", brief: { intent: 'browse', categoryHint: 'concert', performerOrTeam: null }, reply: { state: 'needs_clarification', contains: ['Live music in New York, Oct 1–7'], notContains: [ASKS_HOW_MANY, 'calendar date', 'Which event'] } },
  { id: 'browse.hockey', type: 'browse', text: 'Any hockey games coming up?', brief: { categoryHint: 'nhl' }, reply: { contains: ['Hockey in New York', 'New York Rangers vs. New York Islanders (preseason) at Madison Square Garden', "I've looked at the next two weeks"] } },
  { id: 'browse.games_week', type: 'browse', text: 'What games are on the first week of October?', brief: { categoryHint: 'sports' }, reply: { contains: ['Games in New York, Oct 1–7', 'Madison Square Garden'] } },
  { id: 'browse.msg', type: 'browse', text: "What's on at MSG next weekend?", brief: { intent: 'browse' }, reply: { contains: ['Events in New York', 'here’s what’s on'] } },
  { id: 'browse.things_to_do', type: 'browse', text: 'Things to do in NYC in early October?', brief: { intent: 'browse' }, reply: { contains: ['Events in New York, Oct 1–10'] } },
  { id: 'browse.empty', type: 'browse', text: 'Any good gigs in New York next week?', brief: { categoryHint: 'concert' }, reply: { contains: ["I don't have any live music in New York on file"] } },
  { id: 'browse.basketball', type: 'browse', text: 'Want to catch a basketball game in late October, what is on?', brief: { categoryHint: 'nba' }, reply: { contains: ['Basketball in New York, Oct 21–31', 'New York Knicks vs. Fixture Opponent'] } },
  { id: 'browse.football', type: 'browse', text: 'I want to see an american football game in or near new york the second week of october. Anything interesting? We need 4 tickets.', brief: { categoryHint: 'nfl', intent: 'browse', quantity: 4 }, reply: { state: 'needs_clarification', contains: ['Football in New York, Oct 8–14'], notContains: ['Yankees', "isn't something I cover"] } },
  { id: 'browse.genre_borough', type: 'browse', text: 'Any indie rock gigs in Brooklyn next week?', brief: { categoryHint: 'concert', genreHint: 'rock', city: 'Brooklyn', intent: 'browse' } },
  { id: 'browse.more', type: 'browse', text: 'can you give me the other 7', brief: { wantsMore: true }, reply: { notContains: ['7 tickets', 'seven tickets'] } },
  { id: 'browse.theater', type: 'browse', text: 'Any Broadway shows next week?', brief: { categoryHint: 'theater' }, reply: { state: 'unsupported', contains: ['For now I only cover concerts and NHL, NBA, MLB and NFL games'] } },
  { id: 'browse.comedy', type: 'browse', text: 'Any stand-up comedy this weekend?', brief: { categoryHint: 'comedy' }, reply: { state: 'unsupported' } },
  { id: 'browse.other_city', type: 'browse', text: 'What concerts are on in Chicago next month?', reply: { state: 'unsupported', contains: ['New York area'] } },

  // ── Where the customer lives ─────────────────────────────────────────────────────────────────────────
  { id: 'residence.hurry', type: 'find', text: "I'm in a hurry — two Rangers tickets Oct 3, $300 total.", reply: { contains: ['New York Rangers vs. New York Islanders'], notContains: ['US-only'] } },
  { id: 'residence.brooklyn', type: 'find', text: "I'm in Brooklyn, 2 Knicks tickets Oct 24", reply: { notContains: ['One quick check: we serve US customers only'] } },
  { id: 'residence.uk', type: 'find', text: "I'm based in the UK. Two Rangers tickets Oct 3, $300 total.", reply: { state: 'unsupported', contains: ['US customers'] } },
  { id: 'residence.visiting_from', type: 'find', text: "We're visiting from London, 2 Rangers tickets Oct 3", reply: { state: 'unsupported' } },
  { id: 'residence.tourist_in_ny', type: 'find', text: "I'm in New York for the weekend, 2 Rangers tickets Oct 3", reply: { contains: ['One quick check: we serve US customers only'] } },
  { id: 'event.outside_us', type: 'find', text: 'Two Leafs tickets in Toronto', reply: { state: 'unsupported', contains: ['outside the US'] } },

  // ── Seats and budget ─────────────────────────────────────────────────────────────────────────────────
  { id: 'seats.apart_ok', type: 'find', text: "Four Rangers tickets Oct 3, we don't need to sit together", brief: { quantity: 4, togetherRequired: false } },
  { id: 'seats.together', type: 'find', text: 'Two Rangers tickets Oct 3, side by side please', brief: { togetherRequired: true } },
  { id: 'budget.per_person', type: 'find', text: 'Knicks Oct 24, 4 seats, $150 per person', brief: { budgetCents: 15000, budgetBasis: 'per_ticket', quantity: 4 } },
  { id: 'budget.all_in', type: 'find', text: 'Knicks Oct 24, 2 tickets, $400 all in', brief: { budgetCents: 40000, budgetBasis: 'whole_party' } },
  { id: 'quantity.family', type: 'find', text: 'Rangers Oct 3 for a family of four', brief: { quantity: 4 } },
  { id: 'quantity.two_of_us', type: 'find', text: 'Rangers Oct 3 for the two of us', brief: { quantity: 2 } },
  { id: 'quantity.wife', type: 'find', text: 'Knicks on October 24 for me and my wife', brief: { quantity: 2 } },

  // ── Other request types ──────────────────────────────────────────────────────────────────────────────
  { id: 'watch.drop', type: 'watch', text: 'Knicks Oct 24, 2 tickets, $300 total. Let me know if it drops.', brief: { intent: 'watch_request' } },
  { id: 'stop.watch', type: 'stop', text: 'Please stop the watch, we bought tickets already.', brief: { intent: 'cancel_watch' } },
  { id: 'optout.marketing', type: 'stop', text: 'Unsubscribe me from marketing emails please', reply: { state: 'closed', sends: false } },
  { id: 'delete.data', type: 'stop', text: 'Please delete my data.', reply: { contains: ['CONFIRM'] } },
  { id: 'negation', type: 'find', text: 'Anything except the Knicks — Rangers on Oct 3 for two', brief: { performerOrTeam: 'New York Rangers' } },
  { id: 'gift', type: 'find', text: 'Two Rangers tickets Oct 3 as a gift for my dad', brief: { forSelf: false } },
];
