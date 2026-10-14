/**
 * Long scripted threads (10-12 steps): the customer changes their mind, asks side questions, sends a screenshot, the
 * market moves while they wait, and at the end they ask for a straight answer. Scored per email and as a whole thread
 * (memory, repeats, re-asked questions, coherence with the step where it broke).
 */
import type { Scenario } from '../harness';
import { AS_OF, EV } from '../world';

export const LONG: Scenario[] = [
  {
    id: 'long/rangers-group-saga', capability: 'long-thread', now: AS_OF.rangersWeek, tags: ['long'],
    steps: [
      { text: 'hey looking for rangers tix this thursday, 4 of us', expect: { eventId: EV.rangersBruins, quantity: 4 } },
      { text: 'budget is around $600 total', expect: { eventId: EV.rangersBruins, quantity: 4, budgetCents: 60000 } },
      { text: 'actually make it 5, my brother is coming', expect: { eventId: EV.rangersBruins, quantity: 5 } },
      { text: 'is MSG easy to get to from Penn Station?' },
      { text: 'ok so what are the options for the 5 of us?', expect: { mustMentionAny: ['211', '640', '560', '310'] } },
      { text: 'too pricey. anything cheaper where we still sit together?', expect: { forbid: ['re:310[^\\n]*together'] } },
      {
        kind: 'wait', hours: 48, note: '48h pass; the $640 pair-of-five in 211 sells, its twin from source B goes to $690, a new five-together in 220 appears at $600',
        market: (o) => {
          const l = o[EV.rangersBruins]!;
          o[EV.rangersBruins] = l.filter((x) => x.id !== 'rb-5-upper-211');
          const b = o[EV.rangersBruins]!.find((x) => x.id === 'rb-5-upper-211-b')!;
          b.payableTotalCents = 69000; b.baseTotalCents = 56580; b.mandatoryFeeTotalCents = 12420;
          o[EV.rangersBruins]!.push({ ...b, id: 'rb-5-upper-220-new', providerListingId: 'rb-5-upper-220-new', evidenceId: 'fx-ev-rb-5-upper-220-new', directPurchaseUrl: 'https://example.invalid/fixture/rb-5-upper-220-new', sourceId: 'fixture-source', section: '220', row: 'C', payableTotalCents: 60000, baseTotalCents: 49200, mandatoryFeeTotalCents: 10800 });
        },
      },
      { text: 'still good? did anything change?', expect: { mustMentionAny: ['600', '220'], forbid: ['re:\\$640'] } },
      { text: "what about saturday's game instead?", expect: { eventId: EV.rangersDevils, quantity: 5 } },
      { text: 'nah go back to thursday', expect: { eventId: EV.rangersBruins, quantity: 5 } },
      { text: 'ok just tell me which one to buy', expect: { eventId: EV.rangersBruins, quantity: 5, mustMentionAny: ['220', '600'] } },
      { text: 'perfect thanks!', expect: { noNewRecommendation: true } },
    ],
  },
  {
    id: 'long/knicks-screenshot-alert', capability: 'long-thread', now: AS_OF.knicksWeek, tags: ['long', 'flag-off-in-prod'], env: { WATCH_SEND_ENABLED: 'true' },
    steps: [
      { text: '2 knicks celtics tix wednesday?', expect: { eventId: EV.knicksCeltics, quantity: 2 } },
      { text: 'found these on seatgeek, can you beat it?', screenshots: [{ marketplace: 'SeatGeek', event: 'Boston Celtics at New York Knicks', when: 'Wed, Oct 28 · 7:30 PM · Madison Square Garden', section: '210', row: 'J', quantity: 2, totalDollars: 480, feesIncluded: true }], expect: { eventId: EV.knicksCeltics, quantity: 2, mustMentionAny: ['420'] } },
      { text: 'do you think prices go up before wednesday?', expect: { eventId: EV.knicksCeltics } },
      { text: 'ok let me know if a pair drops under $400 total', expect: { watch: { eventId: EV.knicksCeltics } } },
      {
        kind: 'wait', hours: 20, checkAlerts: true, note: '20h pass; the section 210 pair drops to $380',
        market: (o) => { const x = o[EV.knicksCeltics]!.find((l) => l.id === 'kc-2-upper-210')!; x.payableTotalCents = 38000; x.baseTotalCents = 31160; x.mandatoryFeeTotalCents = 6840; },
        expect: { alertsRaised: 1 },
      },
      { text: 'nice, is that still the best one?', expect: { eventId: EV.knicksCeltics, mustMentionAny: ['380'] } },
      { text: 'and lower bowl, how much would that be?', expect: { mustMentionAny: ['1,100', '1100', '102'] } },
      { text: 'nah too much. what about the nets game sunday instead, same 2', expect: { eventId: EV.knicksNets, quantity: 2 } },
      { text: 'ok stick with celtics', expect: { eventId: EV.knicksCeltics, quantity: 2 } },
      { text: 'thanks, buying the 210 ones', expect: { noNewRecommendation: true } },
    ],
  },
  {
    id: 'long/la-january-discovery', capability: 'long-thread', now: AS_OF.laJanuary, tags: ['long'],
    steps: [
      { text: 'what sports are on in LA the week of jan 12?', expect: { mustMentionAll: ['re:Lakers', 're:Kings'], forbid: ['Bruno Mars', 'Wicked'] } },
      { text: 'the lakers one on tuesday', expect: { eventId: EV.lakersWarriors } },
      { text: '2 tickets, under $500 total', expect: { eventId: EV.lakersWarriors, quantity: 2, budgetCents: 50000 } },
      { text: 'any chance of lower bowl?', expect: { mustMentionAny: ['1,200', '1200', '111'] } },
      { text: 'ok what about the kings game that week instead', expect: { eventId: EV.kingsDucks, quantity: 2 } },
      { text: 'lower bowl for the kings?', expect: { eventId: EV.kingsDucks } },
      { text: 'fine, upper is ok', expect: { eventId: EV.kingsDucks, quantity: 2, mustMentionAny: ['140', '301'] } },
      { text: 'actually is there a clippers game too?', expect: { eventId: EV.clippersSuns } },
      { text: 'which is the best value of the three for 2 of us?', expect: { mustMentionAny: ['re:Clippers|Kings'] } },
      { text: 'go with the kings. send me the link', expect: { eventId: EV.kingsDucks, quantity: 2, mustMentionAny: ['re:https?://'] } },
    ],
  },
];
