/** The first 17 scenarios (Oct 13 baseline), on the fixture clock (Tue Sep 22 2026). */
import type { Scenario } from '../harness';
import { EV } from '../world';

export const CORE: Scenario[] = [
  { id: 'single-total-budget', capability: 'budget', steps: [{ text: 'Hi Ticket Guy, can you find me 5 tickets together for the Rangers preseason game against the Islanders on Oct 3? Budget is $500 total.', expect: { eventId: EV.rangersPreseason, quantity: 5, budgetCents: 50000, budgetBasis: 'whole_party' } }] },
  { id: 'per-ticket-budget', capability: 'budget', steps: [{ text: 'Need 2 seats for the Rangers vs Islanders preseason game, no more than $130 a ticket.', expect: { eventId: EV.rangersPreseason, quantity: 2, budgetCents: 13000, budgetBasis: 'per_ticket' } }] },
  { id: 'party-grows', capability: 'changing-instructions', steps: [{ text: 'Looking for 2 tickets to the Rangers preseason game Oct 3, under $300 total.', expect: { eventId: EV.rangersPreseason, quantity: 2 } }, { text: 'Actually there are five of us now.', expect: { eventId: EV.rangersPreseason, quantity: 5 } }] },
  { id: 'budget-raised', capability: 'changing-instructions', steps: [{ text: '2 tickets for the Knicks game on Oct 24, max $250 total please.', expect: { eventId: EV.knicks, quantity: 2, budgetCents: 25000 } }, { text: 'Ok, we can stretch to $320 total.', expect: { eventId: EV.knicks, quantity: 2, budgetCents: 32000, mustMentionAny: ['310'] } }] },
  { id: 'pick-by-opponent', capability: 'memory', steps: [{ text: 'Two tickets for a Rangers game at MSG in October?' }, { text: 'The Islanders game.', expect: { eventId: EV.rangersPreseason, quantity: 2 } }] },
  { id: 'pick-earlier-one', capability: 'memory', steps: [{ text: 'Two tickets for a Rangers game at MSG in October?' }, { text: 'The earlier one works.', expect: { eventId: EV.rangersPreseason, quantity: 2 } }] },
  { id: 'pick-by-date', capability: 'memory', steps: [{ text: 'Two tickets for a Rangers game at MSG in October?' }, { text: 'Let’s do the one on the 15th.', expect: { eventId: EV.rangersRegular, quantity: 2 } }] },
  { id: 'same-game-new-quantity', capability: 'memory', steps: [{ text: '2 tickets for the Rangers preseason game on Oct 3 please.', expect: { eventId: EV.rangersPreseason, quantity: 2 } }, { text: 'Can you also check what 5 together would cost for the same game?', expect: { eventId: EV.rangersPreseason, quantity: 5 } }] },
  { id: 'switch-team', capability: 'changing-instructions', steps: [{ text: '2 tickets for the Rangers preseason game on Oct 3.', expect: { eventId: EV.rangersPreseason, quantity: 2 } }, { text: 'Actually, let’s do the Knicks game on the 24th instead.', expect: { eventId: EV.knicks, quantity: 2 } }] },
  { id: 'side-question', capability: 'memory', steps: [{ text: '5 tickets for the Rangers preseason game, $500 total.', expect: { eventId: EV.rangersPreseason, quantity: 5, budgetCents: 50000 } }, { text: 'Quick question — is MSG easy to get to from Penn Station?' }, { text: 'Great. So which seats would you go for?', expect: { eventId: EV.rangersPreseason, quantity: 5, budgetCents: 50000 } }] },
  { id: 'which-is-cheapest', capability: 'recommendation', steps: [{ text: 'Looking at 2 tickets for the Rangers vs Islanders preseason game.', expect: { eventId: EV.rangersPreseason, quantity: 2 } }, { text: 'Which option is cheapest?', expect: { eventId: EV.rangersPreseason, quantity: 2, mustMentionAny: ['150', '240'] } }] },
  { id: 'no-inventory-artist', capability: 'unavailable-inventory', steps: [{ text: 'Can you get me 4 tickets to see Dua Lipa in New York?' }] },
  { id: 'vague-browse', capability: 'ambiguous', steps: [{ text: 'Anything good happening at Madison Square Garden in the next few weeks?' }] },
  { id: 'thanks-close', capability: 'conversation', steps: [{ text: '4 tickets for the Yankees game on Sep 30.', expect: { eventId: EV.yankees, quantity: 4 } }, { text: 'Perfect, thanks — all set!', expect: { noNewRecommendation: true } }] },
  { id: 'lower-bowl', capability: 'seating', steps: [{ text: '5 tickets for the Rangers preseason game, lower bowl please, up to $1,000 total.', expect: { eventId: EV.rangersPreseason, quantity: 5, budgetCents: 100000, mustMentionAny: ['110'] } }] },
  { id: 'nickname-typo', capability: 'messy-input', steps: [{ text: '2 NYR tix for the preseason game vs the isles pls', expect: { eventId: EV.rangersPreseason, quantity: 2 } }] },
  // Live email, Oct 15 (Oct 19 vs the Ducks): no listing, no link, 15-hour-old prices, a garbled headline. Nothing fits
  // $150 for this game; the closest seats, how far over, and the Kings game a week later that fits. The world's dates are
  // a month later (Nov 18 and 25) so the October Rangers scenarios see the same games.
  { id: 'over-budget-way-forward', capability: 'recommendation', tags: ['live'], now: '2026-11-12T17:00:00Z', steps: [{ text: 'Rangers vs Ducks, 2 tickets, $150 total', expect: { eventId: EV.rangersDucks, quantity: 2, budgetCents: 15000, hasLink: true, hasNextStep: true, mustMentionAny: ['Nov 25', 'November 25'] } }] },
  // Live email, Oct 13 (that run was hit by the tracing outage).
  { id: 'next-game-question', capability: 'event-discovery', tags: ['live'], steps: [{ text: 'when is the next rangers game in new york?', expect: { eventId: EV.rangersPreseason, mustMentionAny: ['Oct 3', 'October 3', '10/3'] } }] },
  // Live thread, Oct 15 14:06-14:21 ET. Steps 3 and 4 are the customer's exact words; steps 1 and 2 are paraphrased
  // (upcoming Rangers games, then the Nov 16 Montreal game). We sent a $246 pair over the $150 budget with "Would you
  // go up to about $246…?", and answered step 4 with the identical email. "total yes" answers per-ticket-vs-total; the
  // question is the request: which other games have a pair at $150 or less all-in.
  {
    id: 'rangers-budget-other-games', capability: 'budget', tags: ['live'], now: '2026-10-15T18:06:00Z',
    steps: [
      { text: 'what rangers games are coming up?' },
      { text: 'Nov 16 vs Montreal', expect: { eventId: EV.rangersCanadiens } },
      { text: '2 tickets. Max $150', expect: { eventId: EV.rangersCanadiens, quantity: 2, budgetCents: 15000 } },
      { text: 'yes what other games can I see for that price? total yes.', expect: { quantity: 2, budgetCents: 15000, budgetBasis: 'whole_party', mustMentionAll: ['re:Flyers', 're:Sabres', 're:\\$138', 're:\\$149'], forbid: ['re:go up to about \\$246'] } },
    ],
  },
];
