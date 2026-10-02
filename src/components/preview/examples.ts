/**
 * The three illustrative exchanges the hero can play. Each reply is one decision, one party total with its fee
 * basis, and one short reason or material catch (at most one comparison). All quotes, ranges and trends are
 * fictional example data, labelled as such on the page: never a live offer or a verified listing.
 */
export type ExampleKey = 'deal' | 'wait' | 'catch';
export type Example = {
  key: ExampleKey;
  /** The selector label. */
  label: string;
  /** The request, as the email's subject line. */
  subject: string;
  /** The screenshot attached to the request. */
  file: string;
  decision: string;
  total: string;
  basis: string;
  reason: string;
};

export const EXAMPLES: Example[] = [
  {
    key: 'deal',
    label: 'Good deal?',
    subject: 'Two Dua Lipa tickets. Is this a good deal?',
    file: 'dua-lipa-listing.png',
    decision: 'Near the low end of similar listings.',
    total: '$338 for two',
    basis: 'fees included',
    reason: 'Comparable pairs in this illustrative example are $330–$420 with fees.',
  },
  {
    key: 'wait',
    label: 'Buy or wait?',
    subject: 'Five Knicks tickets. Buy now or wait?',
    file: 'knicks-listing.png',
    decision: 'I’d wait if you’re flexible.',
    total: '$1,605 for five',
    basis: 'fees included',
    reason: 'Upper-level asking prices are down 12% this week; five seats together may behave differently.',
  },
  {
    key: 'catch',
    label: 'What’s the catch?',
    subject: 'These seats look cheap. What’s the catch?',
    file: 'cheap-seats-listing.png',
    decision: 'I’d pass if a clear view matters.',
    total: '$190 for two',
    basis: 'fees extra',
    reason: 'Limited view. Tickets arrive the day before.',
  },
];
