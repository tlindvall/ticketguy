/**
 * "Which should I start with: Life Burns Faster, Suite Reservation or the 2-Day Ticket?", "Could I split the 2-Day
 * Ticket with a friend?": questions about which product is concert admission, answered from the products' own names
 * in the catalog before any price search (post-deploy QA Oct 2, R2-2327-03: both got a generic "send me the price,
 * section and row"). Nothing here claims seats are on sale, or reads terms we haven't seen.
 */

export type ProductRow = { name: string; when: string };
export type ProductAnswer = { lead: string; items: string[] };

// A named product, never a passing "split" or "package" ("six seats the seller won't split" is about seats).
// A pack of tickets ("four-pack", "4-pack", "pack of four") is a product too (live Oct 9: "Which MRAK ticket should four
// of us buy?" with a four-pack and GA on the page).
const PACK = /\b(?:(?:[2-9]|two|three|four|five|six)[- ]packs?|packs? of (?:[2-9]|two|three|four|five|six)|group (?:tickets?|pass(?:es)?|bundles?))\b/i;
// "Which admission tier should four of us buy?" names the choice without naming a product: the tiers are the catalog's
// (brief journeys, Oct 10: it went to a resale search with a trend block instead).
const PRODUCT_WORDS = new RegExp(`\\b(?:suite reservations?|suites?|(?:[2-9]|two|three|multi)[- ]day (?:tickets?|pass(?:es)?)|(?:single[- ]day|weekend) pass(?:es)?|(?:admission|ticket|price) (?:tiers?|types?))\\b|${PACK.source}`, 'i');
// "Which MRAK ticket should four of us buy?": which, then a ticket within a few words, is a choice of ticket type.
const ASKS_CHOICE = /\bwhich (?:one |should|do|would|is|of)\b|\bwhich (?:\S+\s+){0,3}?(?:tickets?|tiers?|types?)\b|\bstart with\b|\b(?:could|can|should) (?:i|we) (?:buy|split|share|use)\b|\bsplit(?:ting)?\b|\bis (?:it|this|that) (?:the )?(?:concert )?(?:admission|ticket)\b/i;
/** The pack's size, from its name ("four-pack", "4-pack", "pack of 4"). */
const packSize = (text: string): number | null => {
  const m = /\b(?:([2-9]|two|three|four|five|six)[- ]packs?|packs? of ([2-9]|two|three|four|five|six))\b/i.exec(text);
  const w = (m?.[1] ?? m?.[2] ?? '').toLowerCase();
  const n = { two: 2, three: 3, four: 4, five: 5, six: 6 }[w] ?? Number(w);
  return Number.isInteger(n) && n >= 2 ? n : null;
};
/** A dollar figure the customer wrote within a few words of the product ("the four-pack is $200", "$60 GA"). */
const priceNear = (text: string, product: RegExp): number | null => {
  // The product then its price first ("GA is $60"), so "$200 and GA" never reads the pack's price as GA's.
  const after = new RegExp(`(?:${product.source})[^$.?!]{0,40}\\$(\\d{1,5}(?:\\.\\d{2})?)`, 'i').exec(text);
  const before = after ? null : new RegExp(`\\$(\\d{1,5}(?:\\.\\d{2})?)[^$.?!]{0,40}(?:${product.source})`, 'i').exec(text);
  const v = Number(after?.[1] ?? before?.[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
};
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
export function productChoiceAnswer(latest: string, thread: string, event: ProductRow, others: ProductRow[], opts: { quantity?: number | null } = {}): ProductAnswer | null {
  const all = `${thread}\n${latest}`;
  // A follow-up about splitting the 2-day ticket named in the thread counts too.
  if (!asksProductChoice(latest) && !(SPLIT.test(latest) && PRODUCT_WORDS.test(all))) return null;
  // A pack sized for their group (live Oct 9, MRAK: "Which ticket should four of us buy?"): the recommendation first, in the
  // owner's framework words (Oct 10, case 9: "The four-pack looks best for your group, provided its entry conditions suit
  // you"), then the one thing that would change it and the next step. "Cheaper per person" only from their own figures,
  // never from a price we haven't seen; each caveat said once (Oct 10 review: the terms caveat three times). No seats,
  // prices or resale trend are read.
  // The pack they name, or the one the catalog sells for this show when they ask which tier without naming it.
  const pack = packSize(all) ?? (PRODUCT_WORDS.test(latest) ? packSize(others.map((o) => o.name).join('\n')) : null);
  const q = opts.quantity ?? null;
  if (pack && q && pack === q && !SPLIT.test(latest)) {
    const word = ['', '', 'two', 'three', 'four', 'five', 'six'][pack]!;
    const packPrice = priceNear(all, PACK);
    const single = priceNear(all, /general admission|\bGA\b|single|individual|regular|standard/);
    const usd = (x: number) => `$${x.toFixed(2).replace(/\.00$/, '')}`;
    const terms = 'the pack’s admission terms (who it admits, whether everyone has to enter together, and any age or ID rule)';
    const unseen = `the fees at checkout, which I haven’t seen for ${event.name} on ${event.when}`;
    if (packPrice !== null && single !== null) {
      const each = packPrice / pack;
      return each < single
        ? { lead: `The ${word}-pack is the better buy for your group on the figures you gave: ${usd(each)} each against ${usd(single)} for GA.`, items: [`Before you buy, confirm ${terms} and ${unseen}.`] }
        : { lead: `${word.replace(/^./, (c) => c.toUpperCase())} individual GA tickets are the better buy for your group on the figures you gave: the ${word}-pack works out at ${usd(each)} each against ${usd(single)}.`, items: [`Before you buy, check ${unseen}.`] };
    }
    return { lead: `The ${word}-pack looks best for your group, provided its entry conditions suit you.`, items: [`Whether it works out cheaper per person than ${word} GA tickets depends on two prices I haven’t seen: compare the pack with ${word} singles at checkout, or send me both and I’ll check. Before you buy, confirm ${terms}.`] };
  }
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
