/**
 * "Which should I start with: Life Burns Faster, Suite Reservation or the 2-Day Ticket?", "Could I split the 2-Day
 * Ticket with a friend?": questions about which product is concert admission, answered from the products' own names
 * in the catalog before any price search (post-deploy QA Oct 2, R2-2327-03: both got a generic "send me the price,
 * section and row"). Nothing here claims seats are on sale, or reads terms we haven't seen.
 */

export type ProductRow = { name: string; when: string };
export type ProductAnswer = { lead: string; items: string[] };

// A named product, never a passing "split" or "package" ("six seats the seller won't split" is about seats).
const PRODUCT_WORDS = /\b(?:suite reservations?|suites?|(?:[2-9]|two|three|multi)[- ]day (?:tickets?|pass(?:es)?)|(?:single[- ]day|weekend) pass(?:es)?)\b/i;
const ASKS_CHOICE = /\bwhich (?:one |should|do|would|is|of)\b|\bstart with\b|\b(?:could|can|should) (?:i|we) (?:buy|split|share|use)\b|\bsplit(?:ting)?\b|\bis (?:it|this|that) (?:the )?(?:concert )?(?:admission|ticket)\b/i;
const SPLIT = /\bsplit(?:ting)?\b|\bshare (?:it|the ticket)\b|\b(?:i|we)'?d go\b[^.?!]{0,60}\b(?:they|she|he)'?d go\b/i;
const PROOF = /\b(?:prove|proof|shows? (?:that )?(?:there are|they have)|available|in stock|left)\b/i;

const isMultiDay = (n: string) => /\b(?:[2-9]|two|three|multi)[- ]day\b|\bcannot split\b|\bcan'?t (?:be )?split\b/i.test(n);
const isSuite = (n: string) => /\bsuites?\b/i.test(n);

export function asksProductChoice(text: string, thread = ''): boolean {
  return (PRODUCT_WORDS.test(text) && ASKS_CHOICE.test(text)) || (SPLIT.test(text) && PRODUCT_WORDS.test(`${thread}\n${text}`));
}

/**
 * The answer, or null when it isn't a product question. `event` is the single show they mean; `others` are the
 * catalog's add-ons and bundles for the same act at the same venue around that date.
 */
export function productChoiceAnswer(latest: string, thread: string, event: ProductRow, others: ProductRow[]): ProductAnswer | null {
  const all = `${thread}\n${latest}`;
  // A follow-up about splitting the 2-day ticket named in the thread counts too.
  if (!asksProductChoice(latest) && !(SPLIT.test(latest) && PRODUCT_WORDS.test(all))) return null;
  const multi = others.find((o) => isMultiDay(o.name)) ?? null;
  const suite = others.find((o) => isSuite(o.name)) ?? null;
  const single = `${event.name} on ${event.when}`;
  if (SPLIT.test(latest) && PRODUCT_WORDS.test(all)) {
    const named = multi ? `Ticketmaster lists it as “${multi.name}”, so it’s sold as one ticket for both nights, not as two single-night tickets` : 'a multi-day ticket is sold as one ticket covering every night on it, not as single-night tickets';
    const items = ['Whether two people could each use one of the nights depends on its terms, which I can’t see, so I wouldn’t count on it.'];
    if (PROOF.test(latest)) items.push('And no, the screenshot doesn’t show that two single-night tickets are available: it shows what’s on sale, not whether any seats are left.');
    items.push(`For one night only, ${single} is the ticket to look at.`);
    return { lead: `I wouldn’t plan on splitting it: ${named}.`, items };
  }
  const items: string[] = [];
  if (suite || /\bsuites?\b/i.test(all)) items.push(`${suite ? `“${suite.name}”` : 'The suite reservation'} is a suite booking. I can’t see what it includes or whether it covers concert entry, so it isn’t where I’d start for ordinary tickets.`);
  if (multi || /\b(?:[2-9]|two)[- ]day\b/i.test(all)) items.push(`${multi ? `“${multi.name}”` : 'The 2-day ticket'} is one ticket for more than one night${multi && /cannot split|can'?t (?:be )?split/i.test(multi.name) ? ', and it says it can’t be split by day' : ''}, so it isn’t a ticket for one night on its own.`);
  if (/\b(?:hotel|vip)\b/i.test(all)) items.push('Hotel packages and VIP add-ons are sold separately; the single-night ticket doesn’t need either.');
  items.push('I haven’t seen seats or prices for it yet. Send me the ones you find (a screenshot works) and I’ll check them against what you need.');
  return { lead: `Start with ${single}: that’s the concert ticket for that night on its own.`, items };
}
