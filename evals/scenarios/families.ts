/**
 * Scenario families from the founder's examples (Oct 13). Each family is one job phrased several ways: clean, messy
 * (typos, nicknames, text-speak, lowercase) and, where it exists, ambiguous. The messy versions must reach the same
 * event, party and budget as the clean one; when they don't, the failing word is the bug.
 */
import type { Expect, Scenario, Step } from '../harness';
import { AS_OF, EV, LINKS } from '../world';

const fam = (base: string, capability: string, now: string | undefined, expect: Expect, phrasings: Array<[variant: string, text: string]>, tags: string[] = []): Scenario[] =>
  phrasings.map(([v, text]) => ({ id: `${base}/${v}`, capability, now, tags: [base, v.startsWith('messy') ? 'messy' : v, ...tags], steps: [{ text, expect }] }));

// "I need 5 tickets to rangers this thursday" (clock: Mon Oct 19 2026; Thursday = Rangers vs Bruins, Oct 22)
const rangersThursday = fam('rangers-this-thursday', 'event-resolution', AS_OF.rangersWeek, { eventId: EV.rangersBruins, quantity: 5 }, [
  ['clean', 'I need 5 tickets to the Rangers game this Thursday.'],
  ['messy-nickname', 'need 5 seats for the blueshirts thurs'],
  ['messy-abbrev', '5 tix NYR thursday night pls'],
  ['messy-typo', 'Can you find me 5 tickts to the Rangres this thrusday?'],
  ['messy-textspeak', 'yo me + 4 friends tryna see the rags thurs at the garden'],
]);

// "What are prices and do you think they will go up or down?" (falling trend on file for this game)
const priceTrend = fam('price-and-trend', 'timing-advice', AS_OF.rangersWeek, { eventId: EV.rangersBruins, quantity: 5, mustMentionAny: ['640', 're:\\$6\\d\\d'], forbid: ['re:(will|going to) (definitely|certainly) (go|drop|rise)'] }, [
  ['clean', 'I need 5 tickets to the Rangers this Thursday. What are prices and do you think they will go up or down?'],
  ['messy', '5 rangers tix thurs, whats the price rn and r they gonna go up or down?'],
  ['messy-wait', 'should i wait to buy 5 nyr tickets for thursday or buy now? are prices dropping'],
]);

// "Check this link — are these good seats?"
const linkCheck: Scenario[] = [
  ...fam('link-good-seats', 'links', AS_OF.rangersWeek, { eventId: EV.rangersBruins, quantity: 2, mustMentionAny: ['224', 'upper'] }, [
    ['ticketmaster', `Are these good seats? Section 224 row G, 2 tickets for $260 total: ${LINKS.rangersBruinsTm}`],
    ['stubhub', `check this link, are these good seats? sec 224 row G 2 for $260 ${LINKS.rangersBruinsStubhub}`],
    ['messy', `found these r they any good?? ${LINKS.rangersBruinsStubhub} sec 224 row g`],
  ]),
  { id: 'link-good-seats/unknown-event', capability: 'links', now: AS_OF.rangersWeek, tags: ['link-good-seats', 'unknown'], steps: [{ text: `Can you check these? ${LINKS.unknownEventTm} 2 tickets, section 105`, expect: { forbid: ['re:great seats', 're:good seats'] } }] },
  { id: 'link-good-seats/app-share-link', capability: 'links', now: AS_OF.rangersWeek, tags: ['link-good-seats', 'unreadable'], steps: [{ text: `Are these good? ${LINKS.appShareLink}`, expect: { asksOneQuestion: true } }] },
];

// "Will it send screenshots and ask if these tickets can be found cheaper?" (same section is $640 on file vs $720 in the shot)
const shot = { marketplace: 'StubHub', event: 'New York Rangers vs Boston Bruins', when: 'Thu, Oct 22 · 7:00 PM · Madison Square Garden', section: '211', row: 'B', quantity: 5, totalDollars: 720, feesIncluded: true };
const screenshotCheaper: Scenario[] = [
  { id: 'screenshot-cheaper/clean', capability: 'screenshots', now: AS_OF.rangersWeek, tags: ['screenshot-cheaper', 'clean'], steps: [{ text: 'Can you find these cheaper?', screenshots: [shot], expect: { eventId: EV.rangersBruins, quantity: 5, mustMentionAny: ['640'] } }] },
  { id: 'screenshot-cheaper/messy', capability: 'screenshots', now: AS_OF.rangersWeek, tags: ['screenshot-cheaper', 'messy'], steps: [{ text: 'cheaper anywhere??', screenshots: [shot], expect: { eventId: EV.rangersBruins, quantity: 5, mustMentionAny: ['640'] } }] },
  { id: 'screenshot-cheaper/before-fees', capability: 'screenshots', now: AS_OF.rangersWeek, tags: ['screenshot-cheaper', 'fees'], steps: [{ text: 'is this a good price or can you beat it', screenshots: [{ ...shot, totalDollars: 590, feesIncluded: false }], expect: { eventId: EV.rangersBruins, quantity: 5, mustMentionAny: ['re:fee'] } }] },
  { id: 'screenshot-cheaper/blurry', capability: 'screenshots', now: AS_OF.rangersWeek, tags: ['screenshot-cheaper', 'blurry'], // A blurry shot: read it right (5 tickets) or ask; never state a misread as fact.
    steps: [{ text: 'can u beat this price', screenshots: [{ ...shot, blurry: true }], expect: { quantity: 5, forbid: ['re:\\b(3|three|4|four|6|six) tickets'] } }] },
];

// "Do tickets still exist for this concert?"
const concertAvailability: Scenario[] = [
  ...fam('concert-availability-soldout', 'availability', undefined, { eventId: EV.billieForum, mustMentionAny: ['re:sold out', 're:no (resale )?(listings|tickets)', 're:(couldn.t|can.t|didn.t) find'] }, [
    ['clean', 'Do tickets still exist for the Billie Eilish concert at the Forum on October 9?'],
    ['messy', 'r there still billie elish tix for the forum show oct 9'],
  ]),
  ...fam('concert-not-on-sale', 'availability', undefined, { eventId: EV.oliviaMsg, mustMentionAny: ['Oct 2', 'October 2'] }, [
    ['clean', 'Can I get 2 tickets for Olivia Rodrigo at MSG in November?'],
    ['messy', 'olivia rodriguez msg nov tix?? need 2'],
  ]),
];

// "What are some cool sport events happening in LA the week of Jan 12?" (clock: Mon Jan 4 2027)
const laWeek = fam('la-sports-week', 'event-discovery', AS_OF.laJanuary, { mustMentionAll: ['re:Lakers|Clippers', 're:Kings|Rams'], forbid: ['Bruno Mars', 'Wicked', 'Spurs'] }, [
  ['clean', 'What are some cool sport events happening in LA the week of Jan 12?'],
  ['messy', 'any good sports games in LA week of jan 12'],
  ['messy-short', 'la sports 1/12 week?'],
  ['messy-typo', 'whats goin on sports wise in los angelas the week of the 12th of january'],
]);

// "Can you let me know if tickets for LA Dodgers go down to $120 next Wednesday" (clock: Thu Sep 24; next Wed = Sep 30 vs
// Giants). The cheapest pair is $90 each, so the target sits below it. Price alerts are OFF in production
// (render.yaml WATCH_SEND_ENABLED=false): these scenarios switch them on to test the feature, and one runs with the
// production setting, where the honest answer is that alerts aren't available.
const dodgersDrop = (id: string, text: string, drops: boolean, tags: string[]): Scenario => ({
  id, capability: 'price-alerts', now: AS_OF.dodgersWeek, tags: ['dodgers-price-alert', 'flag-off-in-prod', ...tags], env: { WATCH_SEND_ENABLED: 'true' },
  steps: [
    { text, expect: { eventId: EV.dodgersGiants, quantity: 2, watch: { eventId: EV.dodgersGiants } } },
    {
      kind: 'wait', hours: 26, checkAlerts: true, note: drops ? '26h pass; upper-deck pair drops to $140 ($70 each)' : '26h pass; prices unchanged',
      market: drops ? (o) => { const x = o[EV.dodgersGiants]!.find((l) => l.id === 'dg-2-upper-14td')!; x.payableTotalCents = 14000; x.baseTotalCents = 11480; x.mandatoryFeeTotalCents = 2520; } : undefined,
      expect: { alertsRaised: drops ? 1 : 0 },
    },
  ],
});
const dodgersAlerts: Scenario[] = [
  dodgersDrop('dodgers-price-alert/clean-drops', 'Can you let me know if tickets for the Dodgers game next Wednesday go down to $75 each? We need 2.', true, ['clean']),
  dodgersDrop('dodgers-price-alert/messy-drops', 'lmk if doyers tix next wed drop to 75 a ticket, need 2', true, ['messy']),
  dodgersDrop('dodgers-price-alert/no-drop', 'Let me know if 2 Dodgers tickets for next Wednesday get down to $75 each.', false, ['no-drop']),
  { id: 'dodgers-price-alert/production-flags', capability: 'price-alerts', now: AS_OF.dodgersWeek, tags: ['dodgers-price-alert', 'production-flags'], steps: [{ text: 'Can you let me know if tickets for the Dodgers game next Wednesday go down to $75 each? We need 2.', expect: { eventId: EV.dodgersGiants, mustMentionAny: ["re:can.t (watch|track|monitor|alert)", 're:(not|isn.t) (able|available)'] } }] },
];

// Ambiguity: the right move is one short question, not a guess.
const ambiguous: Scenario[] = [
  { id: 'ambiguous/giants', capability: 'ambiguous', now: '2026-09-28T15:00:00Z', tags: ['ambiguous'], steps: [{ text: 'giants tickets this weekend? 2 of us', expect: { asksOneQuestion: true } }] },
  { id: 'ambiguous/hamilton-two-shows', capability: 'ambiguous', tags: ['ambiguous'], steps: [{ text: '2 tickets to Hamilton on October 10', expect: { asksOneQuestion: true, mustMentionAll: ['re:2(:00)? ?p', 're:8(:00)? ?p'] } }] },
];

// Nicknames and typos for single requests across teams.
const nicknames: Scenario[] = [
  ...fam('nickname-knicks', 'messy-input', AS_OF.knicksWeek, { eventId: EV.knicksCeltics, quantity: 2 }, [
    ['clean', '2 tickets for the Knicks vs Celtics game on Wednesday'],
    ['messy-nickname', '2 tix knickerbockers vs the celts wed'],
    ['messy-typo', '2 knciks celtcs tickets wednsday'],
  ]),
  ...fam('nickname-lakers', 'messy-input', AS_OF.laJanuary, { eventId: EV.lakersWarriors, quantity: 2 }, [
    ['clean', '2 tickets to the Lakers vs Warriors on January 12'],
    ['messy-nickname', 'lake show vs dubs jan 12, need 2'],
  ]),
  ...fam('nickname-yankees', 'messy-input', undefined, { eventId: EV.yankees, quantity: 4 }, [
    ['clean', '4 tickets for the Yankees game on September 30'],
    ['messy-nickname', '4 for the bronx bombers 9/30'],
    ['messy-short', 'yanks 9/30 x4'],
  ]),
];

export const FAMILIES: Scenario[] = [...rangersThursday, ...priceTrend, ...linkCheck, ...screenshotCheaper, ...concertAvailability, ...laWeek, ...dodgersAlerts, ...ambiguous, ...nicknames];
export type { Step };
