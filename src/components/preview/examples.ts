/**
 * The three illustrative exchanges the hero can play, one per question a visitor can ask. Every listing fact is
 * attributed to the listing ("The listing says"); market numbers are labelled as context. None is a live offer.
 */
export type ExampleKey = 'deal' | 'wait' | 'catch';
export type Fact = { strong: string; rest: string; tag: string; flag?: boolean };
export type Example = {
  key: ExampleKey;
  subject: string;
  link: string;
  ask: string;
  file: string;
  event: string;
  facts: Fact[];
  market: { label: string; value: string; series?: number[] } | null;
  verdict: string;
  call: string;
  note: string;
};

export const EXAMPLES: Example[] = [
  {
    key: 'deal',
    subject: 'Is this a good deal?',
    link: 'ticketmaster.com/dua-lipa-new-york-11-13-2026…',
    ask: '\nTwo of us. Is $150 each fair?',
    file: 'ticketmaster-section-105.png',
    event: 'Dua Lipa · Fri, Nov 13 · Madison Square Garden',
    facts: [
      { strong: '2 tickets', rest: ', Section 105, Row 12', tag: 'Seats together' },
      { strong: '$338 for two', rest: ', fees included', tag: '$169 each' },
      { strong: 'Mobile tickets', rest: ', ready now', tag: 'Instant' },
    ],
    market: { label: 'Similar lower-level seats are asking', value: '$165–$210 each' },
    verdict: 'My call: fair price',
    call: 'A fair price for the section.',
    note: 'At the low end of similar listings, with fees in. If the view matters, check it before you pay.',
  },
  {
    key: 'wait',
    subject: 'Buy now or wait?',
    link: 'seatgeek.com/new-york-knicks-tickets/11-4-2026…',
    ask: '\nFive of us, want to sit together.',
    file: 'seatgeek-section-414.png',
    event: 'Bulls at Knicks · Wed, Nov 4 · Madison Square Garden',
    facts: [
      { strong: '5 tickets', rest: ', Section 414, Row 3', tag: 'Seat numbers not shown' },
      { strong: '$1,605 for five', rest: ', fees included', tag: '$321 each' },
      { strong: 'Mobile tickets', rest: ', delivered by Nov 2', tag: '2 days before' },
    ],
    market: { label: 'Asking prices in the upper level', value: '▼ 12% this week', series: [146, 145, 147, 144, 146, 145, 147, 146, 148, 147, 150, 149, 152, 155, 158, 161, 165, 168, 170, 169, 166, 162, 158, 153, 149, 145, 141, 137, 134, 130] },
    verdict: 'My call: hold off',
    call: 'Prices are trending down.',
    note: 'Down 12% this week in the upper level. Reply any time and I’ll check again.',
  },
  {
    key: 'catch',
    subject: 'What’s the catch?',
    link: 'vividseats.com/rangers-tickets-msg-11-20-2026…',
    ask: '\nTwo in Section 112 for $95 each. Seems low?',
    file: 'vividseats-section-112.png',
    event: 'Rangers vs. Bruins · Fri, Nov 20 · Madison Square Garden',
    facts: [
      { strong: 'Limited view', rest: ', noted on the listing', tag: 'Check', flag: true },
      { strong: 'Delivery', rest: ' the day before the game', tag: 'Check', flag: true },
      { strong: '$95 each', rest: ', fees not shown yet', tag: 'Check', flag: true },
    ],
    market: null,
    verdict: 'My call: check first',
    call: 'Cheap for a reason: the view.',
    note: 'If a clear view or early delivery matters, I’d compare another option. Confirm the total at checkout.',
  },
];

/** Other parts of the page ask the hero to play an example with this event. */
export const EXAMPLE_EVENT = 'tg:example';
