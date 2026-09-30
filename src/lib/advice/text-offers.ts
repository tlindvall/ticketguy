import { admissionTerms, entryTerm, nightTiming, type Admission, type ProductKind, type EntryTerm, type NightTiming } from './concert-terms';
import { unglue } from '@/lib/domain/event-constraints';
/**
 * Offers a customer lays out in their own words ("Offer A says wheelchair-accessible spaces, $80 each including
 * fees. Offer B is ordinary seats together, section 211 row 12, $105 each including fees."). Each is one record
 * with what the text says about it and nothing more: these are their notes, not listings we've seen, and no
 * field of one offer is ever filled from another (post-#54 QA, R3-B01).
 */
export type TextOffer = {
  admission: Admission;
  admissionStated: boolean;
  productKind: ProductKind;
  entry: EntryTerm | null;
  /** Explicit price basis, so corrections override older totals. */
  priceBasisStated: boolean;
  label: string;
  /** How the offer is named in a sentence: "Offer A", "the green listing", "the first seller". */
  name: string;
  /** Tickets in the offer as described ("five together", "six ordinary unobstructed seats"); null when not said. */
  quantity: number | null;
  /** The seller won't split the block ("all six must be bought", "requires buying all six", "cannot split"). */
  mustBuyAll: boolean;
  perTicketCents: number | null;
  /** A total as stated for the whole offer. */
  totalCents: number | null;
  /** A charge for the whole order, added once ("plus $40 in fees for the whole order", "+ $48 per order"). */
  orderFeeCents: number | null;
  /** A fee charged on every ticket on top of its price ("a $12.75 fee PER TICKET"). */
  perTicketFeeCents: number | null;
  /** How the stated price was worded. A per-order fee on top of a before-fees price is kept apart. */
  feeBasis: 'all_in' | 'before_fees' | 'unknown';
  /** They say there's nothing else to pay ("no other charges"). */
  noOtherCharges: boolean;
  accessible: boolean;
  /** true: obstructed or limited view; false: said unobstructed; null: not said. */
  obstructed: boolean | null;
  together: boolean | null;
  /** Adjacent pairs, not one block ("two adjacent pairs"): true only when said. */
  pairs: boolean;
  section: string | null;
  row: string | null;
  /** Delivery is described for it (on the offer, or for all of them). */
  deliveryStated: boolean;
  /** When the tickets arrive, in the venue's local minutes after midnight on the event day: 0 for immediate; null when not said. */
  deliveryMinutes: number | null;
  /** The delivery time as they wrote it, when it was in another timezone ("10:30am Los Angeles time"). */
  deliveryAsWritten: string | null;
  /** Another name they gave the same offer ("Offer A (Gold)"): matched to it across the thread. */
  alias?: string | null;
};

const money = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, pair: 2 };
const num = (s: string) => WORDS[s.toLowerCase()] ?? Number(s);
const NUMBER = '(one|two|three|four|five|six|seven|eight|nine|ten|pair|\\d{1,2})';

/** "including all fees", "INCLUDING every fee", "fees included", "all-in". */
export const ALL_IN = /\b(?:including|incl\.?|inclusive of|with)\s+(?:all|every|any)?\s*(?:the\s+)?(?:fees?|charges)\b|\ball[- ]in\b|\bfees?\s+(?:are\s+)?included\b/i;
/** "before fees", "plus fees", "excluding fees", "BEFORE fees". */
const BEFORE_FEES = /\b(?:before|plus|\+|excluding|excl\.?|not including)\s+(?:any\s+|the\s+)?fees?\b/i;
const ORDER_FEE = /\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(?:in\s+)?(?:fees?|service fees?|charges?)?\s*(?:for|per|on)\s+(?:the\s+)?(?:whole\s+|entire\s+)?order\b/i;
/** "a $12.75 fee PER TICKET", "$10 in fees per ticket", "$12.75 per-ticket fee". */
const PER_TICKET_FEE = /\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(?:in\s+)?(?:service\s+)?fees?\s+(?:per|a|each|on each)\s+(?:ticket|seat)\b|\$\s?(\d[\d,]*(?:\.\d{2})?)\s*per[- ](?:ticket|seat)\s+fees?\b/i;
/** A sentence that is the customer talking, not describing the offer: the offer ends there. */
const THEIR_WORDS = /^(?:I|I'm|I'd|We|We're|My|Our|Which|Please|These|Those|Neither|Can|Could|Should|What|How|Is|Are|Do|Does|Would|On price|Thanks|Also|Treat|Don't|Using|All (?:the )?offers|All (?:say|state|show|list)|All of (?:them|these)|Both (?:offers|of them|say|are|listings)|Each (?:offer|of them|child|kid|adult)|(?:The )?(?:Kids|Children|Adults)|Pairs are|Singles are|Budget|Cap)\b/;
const DELIVERY = /\b(?:deliver(?:y|ed|s)?|transfer(?:s|red)?|arriv(?:e|es|al)|mobile ticket|e-?ticket)\b/i;
const NEGATED = /\b(?:no|not|neither|nor|non|isn't|aren't|without|never)\b[^.;]{0,30}$/i;
const TIME = '(noon|midday|midnight|\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\.?)';

/** A timezone named after a time ("1pm NEW YORK time", "10:30am PT"), as hours behind New York. */
const ZONE = '(?:\\s*,?\\s*(?:(new york|nyc|eastern|los angeles|la|pacific|chicago|central|denver|mountain)(?:\\s+time)?|\\b(ET|EDT|EST|PT|PDT|PST|CT|CDT|CST|MT|MDT|MST)\\b))?';
const ZONE_BEHIND_NY: Record<string, number> = { 'new york': 0, nyc: 0, eastern: 0, et: 0, edt: 0, est: 0, chicago: 1, central: 1, ct: 1, cdt: 1, cst: 1, denver: 2, mountain: 2, mt: 2, mdt: 2, mst: 2, 'los angeles': 3, la: 3, pacific: 3, pt: 3, pdt: 3, pst: 3 };
const TZ_BEHIND_NY: Record<string, number> = { 'America/New_York': 0, 'America/Detroit': 0, 'America/Chicago': 1, 'America/Denver': 2, 'America/Phoenix': 3, 'America/Los_Angeles': 3 };
const ZONE_NAME: Record<number, string> = { 0: 'New York', 1: 'Chicago', 2: 'Denver', 3: 'Los Angeles' };

/** A time written in a named zone, as the venue's local minutes; unchanged when no zone is named or known. */
export function toVenueMinutes(minutes: number, zone: string | null, venueTz: string): number {
  if (!zone) return minutes;
  const from = ZONE_BEHIND_NY[zone.toLowerCase()];
  const to = TZ_BEHIND_NY[venueTz];
  return from === undefined || to === undefined ? minutes : minutes + (from - to) * 60;
}
/** The venue's local minutes as they read in a named zone ("New York"); unchanged when either is unknown. */
export function fromVenueMinutes(minutes: number, zoneName: string | null, venueTz: string): number {
  if (!zoneName) return minutes;
  const to = ZONE_BEHIND_NY[zoneName.toLowerCase()];
  const from = TZ_BEHIND_NY[venueTz];
  return from === undefined || to === undefined ? minutes : minutes + (from - to) * 60;
}
export function venueZoneName(venueTz: string): string | null {
  const b = TZ_BEHIND_NY[venueTz];
  return b === undefined ? null : ZONE_NAME[b] ?? null;
}

/**
 * One line, one space: text generated from an HTML email wraps at about 80 characters, and "no other\ncharges"
 * failed a phrase that "no other charges" passed (live X01, post-#55 QA).
 */
export function flat(text: string): string {
  return unglue(text).replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

function sentences(s: string): string[] {
  return s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
}

/** A positive mention of the word in the text, not "neither is a wheelchair space". */
function says(text: string, re: RegExp): boolean {
  for (const sen of sentences(text)) {
    const m = re.exec(sen);
    if (m && !NEGATED.test(sen.slice(0, m.index))) return true;
  }
  return false;
}

/** "noon" → 720, "6pm" → 1080, "7:30 pm" → 1170. */
export function minutesOf(t: string): number | null {
  const s = t.toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
  if (s === 'noon' || s === 'midday') return 720;
  if (s === 'midnight') return 0;
  const m = /^(\d{1,2})(?::(\d{2}))?([ap])m$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]) % 12 + (m[3] === 'p' ? 12 : 0);
  return h * 60 + Number(m[2] ?? 0);
}

/** When a piece of offer text says the tickets arrive: 0 for immediate, else the time on the day; null if unsaid. */
function deliveryIn(seg: string): { minutes: number; zone: string | null; written: string } | null {
  if (!DELIVERY.test(seg) && !/\binstant\b/i.test(seg)) return null;
  if (/\b(?:immediate(?:ly)?|instant(?:ly)?|right away|straight away)\b/i.test(seg)) return { minutes: 0, zone: null, written: 'immediate' };
  const m = new RegExp(`\\b(?:deliver\\w*|transfer\\w*|arriv\\w*|sent|send)\\b[^.;]{0,40}?\\b(?:by|before|at|no later than)\\s+${TIME}${ZONE}`, 'i').exec(seg);
  const at = m ? minutesOf(m[1]!) : null;
  return m && at !== null ? { minutes: at, zone: m[2] ?? m[3] ?? null, written: m[0].replace(/^.*?\b(?:by|before|at|no later than)\s+/i, '') } : null;
}

export function timeLabel(minutes: number): string {
  if (minutes === 720) return 'noon';
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
}

/** Words that aren't names: "the whole order", "the same listing", "the cheapest option". */
const NOT_A_NAME = /^(?:whole|same|other|cheapest|cheaper|best|original|old|new|seller's|official|only|exact|actual|first-row|entire|full|last)$/i;
const ORDINAL = /^(?:first|second|third|fourth|fifth)$/i;
/** Capitalised words after "Offer" that are not its name: "Offer Is", "Offer For", "Seller Sent". */
const OFFER_WORD_NOT_NAME = /^(?:Is|Was|Has|Had|For|The|And|But|Costs?|Says|Sent|Only|Total|Price|Prices|Details|Terms|Here|That|This|Which|Includes?|Gives?|Now|Still|Seats?|Tickets?)$/;

/**
 * Where each offer starts and what it is called: "Offer A"/"Option 2", or, when they name them another way,
 * "the green listing"/"the gold listing" or "First seller"/"Second seller" (post-#56 QA V01, V04). A name used
 * once is kept once; two or more names make a comparison.
 */
function offerMarks(t: string, minimum = 2): Array<{ index: number; label: string; name: string; alias?: string }> {
  // "Offer A", "Option 2", "Offer Gold", "Seller North": a letter, a number or a capitalised name after the word.
  // A name in brackets after a letter is the same offer under its old name: "Offer A (Gold)" (TGQA-R8 S05).
  const lettered = [...t.matchAll(/\b([Oo]ffer|[Oo]ption|[Ll]isting|[Ss]eller)\s+([A-Z][a-z]{2,}|[A-Z]|[1-9])\b(?:\s*\(([A-Z][a-z]{2,})\))?/g)]
    .filter((m) => m[2]!.length === 1 || !OFFER_WORD_NOT_NAME.test(m[2]!))
    .map((m) => ({ index: m.index!, label: m[2]!.length === 1 ? m[2]! : m[2]!.toLowerCase(), name: `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]}`, alias: m[3]?.toLowerCase() }));
  // Bare letters: "A is five ordinary seats…, B is six together…", "A at $360 arrives by 5pm, B at $390…" (TGQA-R6 07, 09),
  // also beside a lettered one in the same message ("The same Offer B is immediate…; A is $360…", R8 14).
  // "and B $220 TOTAL" in a list, but not "A $24 fee applies" opening a sentence.
  const bare = [...t.matchAll(/(?:^|[.;:!?]\s+|,\s+|\band\s+|\bbut\s+)([A-E])(?:\s+(?:is|has|costs|at|for|gives|says|copied offer says|remains|still|now|would be|comes to|was|delivers|arrives)\s|[, :]\s+)|(?:,\s+|\band\s+|:\s+)([A-E])\s+(?=\$)/g)]
    .map((m) => ({ index: m.index! + m[0].indexOf((m[1] ?? m[2])!), label: (m[1] ?? m[2])!, name: `Offer ${m[1] ?? m[2]}` }));
  const letters = [...lettered, ...bare.filter((b) => !lettered.some((l) => l.label === b.label || Math.abs(l.index - b.index) < 8))].sort((a, b) => a.index - b.index);
  if (new Set(letters.map((m) => m.label)).size >= minimum) return letters;
  // Named by the marketplace, each with its price: "StubHub $90 each plus $40…; TickPick $105 each…; Vivid Seats $95…".
  const sellers = [...t.matchAll(/\b(StubHub|TickPick|Vivid(?: Seats)?|SeatGeek|Gametime|Ticketmaster|AXS)\b(?=\s*(?:is\s+|now\s+|at\s+|:\s*|,\s*)?(?:shows\s+)?\$)/gi)].map((m) => {
    const name = m[1]!.toLowerCase().startsWith('vivid') ? 'Vivid Seats' : ({ stubhub: 'StubHub', tickpick: 'TickPick', seatgeek: 'SeatGeek', gametime: 'Gametime', ticketmaster: 'Ticketmaster', axs: 'AXS' } as Record<string, string>)[m[1]!.toLowerCase()]!;
    return { index: m.index!, label: name.toLowerCase(), name };
  });
  if (new Set(sellers.map((m) => m.label)).size >= minimum) return sellers;
  const named = [
    ...[...t.matchAll(/\b[Tt]he\s+([a-z]+)\s+(listing|offer|option|seller|block)\b/g)].filter((m) => !NOT_A_NAME.test(m[1]!)).map((m) => ({ index: m.index!, label: m[1]!.toLowerCase(), name: `the ${m[1]!.toLowerCase()} ${m[2]}` })),
    ...[...t.matchAll(/\b(First|Second|Third|Fourth|Fifth|first|second|third|fourth|fifth)\s+(seller|listing|offer|option)\b/g)].filter((m) => ORDINAL.test(m[1]!)).map((m) => ({ index: m.index!, label: m[1]!.toLowerCase(), name: `the ${m[1]!.toLowerCase()} ${m[2]}` })),
  ].sort((a, b) => a.index - b.index);
  if (new Set(named.map((m) => m.label)).size >= minimum) return named;
  // A bare name and a colon, each with its own price: "North: four scattered singles, $400… South: two adjacent pairs,
  // $480…" (TGQA-R8 S05: the same offers under any labels give the same answer).
  const colon = [...t.matchAll(/(?:^|[.;!?]\s+)([A-Z][a-z]{2,})\s*:\s/g)]
    .filter((m) => !OFFER_WORD_NOT_NAME.test(m[1]!) && !/^(?:Note|Budget|Cap|Total|Update|Correction|Offers?|Options?|Also|Details|Terms|Question|Re|Subject|Deadline|Delivery)$/i.test(m[1]!))
    .map((m) => ({ index: m.index! + m[0].indexOf(m[1]!), label: m[1]!.toLowerCase(), name: m[1]! }));
  const priced = colon.filter((m, i) => /\$\s?\d/.test(t.slice(m.index, colon[i + 1]?.index ?? t.length)));
  return new Set(priced.map((m) => m.label)).size >= Math.max(minimum, 2) ? priced : [];
}

/** `minimum` 1 reads the one offer kept from a comparison ("ignore Offer A, only B"); the default needs two. */
export function offersInText(text: string, venueTz = 'America/New_York', minimum = 2, opts: { priceless?: boolean } = {}): TextOffer[] {
  const t = flat(text);
  const marks = offerMarks(t, minimum);
  if (marks.length < minimum) return [];
  // Delivery said once for all of them ("All say transfer before noon", "Both transfer immediately").
  // A clause counts too: "Same section and row; both offers say immediate transfer" (live V04).
  const shared = sentences(t).map((s) => /(?:^|[;:,]\s+)((?:All|Both|Each|all|both|each)\b.*)$/.exec(s)?.[1] ?? null).find((s) => s !== null && !/\b(?:offer|option|listing)\s+[A-Z1-9]\b/i.test(s) && DELIVERY.test(s)) ?? null;
  const sharedDelivery = shared ? deliveryIn(shared) : null;
  const out: TextOffer[] = [];
  for (let i = 0; i < marks.length; i++) {
    const label = marks[i]!.label;
    // An offer already read with its price is done; one first mentioned without a price ("Vivid now shows $25 in
    // fees for the order") is read again where its price is, and the two mentions are folded together.
    const priced = (lab: string) => out.some((o) => o.label === lab && (o.totalCents !== null || o.perTicketCents !== null));
    if (priced(label)) continue;
    // A later mention of an offer already read ("the gold listing is cheaper") is not a new offer, and doesn't cut it short.
    const nextNew = marks.slice(i + 1).find((m) => m.label !== label && !priced(m.label));
    const raw = t.slice(marks[i]!.index, nextNew?.index ?? t.length);
    // The offer runs to the next label, or to the first sentence in their own voice.
    const kept: string[] = [];
    for (const s of sentences(raw)) {
      if (kept.length && THEIR_WORDS.test(s)) break;
      kept.push(s);
    }
    const seg = kept.join(' ');
    const fee = ORDER_FEE.exec(seg);
    const tFee = PER_TICKET_FEE.exec(seg);
    const priceRe = /\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(each|a ticket|per ticket|\/ticket|apiece|pp|a seat|per seat|total|in total|for (?:both|all|the two|the pair))?/gi;
    let price: RegExpExecArray | null = null;
    for (let m = priceRe.exec(seg); m; m = priceRe.exec(seg)) {
      if ((fee && m.index === fee.index) || (tFee && m.index === tFee.index)) continue;
      price = m;
      break;
    }
    const entitlement = admissionTerms(seg);
    // Mentioned without a price ("Offer B is immediate transfer, all fees included") it still updates that offer
    // when the thread's offers are merged; alone it isn't an offer.
    if (!price && !entitlement.admissionStated && !entryTerm(seg) && !opts.priceless) continue;
    const priceFound = price;
    const quote = price ?? { 0: '', 1: '', 2: '', index: seg.length };
    const cents = priceFound ? money(priceFound[1]!) : null;
    // "four … seats together for $180 including all fees" is the block's price, not $180 a seat.
    const forTheBlock = !quote[2] && /\bfor\s*$/i.test(seg.slice(Math.max(0, quote.index - 6), quote.index)) && /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|pair|\d{1,2})\s+(?:[a-z-]+\s+){0,3}?(?:seats?|tickets?|together|pairs|singles)\b/i.test(seg.slice(0, quote.index));
    // "$190 all-in for both" and "$316 including fees in total" put the fee words between the price and "for both".
    const forAllAfterFees = !quote[2] && /^\s*(?:all[- ]in|including (?:all |every )?(?:fees?|charges)|with fees)\s*,?\s*(?:for (?:both|all\b|the two|the pair|the (?:whole )?(?:order|block))|(?:in )?total)/i.test(seg.slice(quote.index + quote[0].length));
    const isTotal = forTheBlock || forAllAfterFees || /total|for (both|all|the two|the pair)/i.test(quote[2] ?? '');
    // "six ordinary unobstructed seats together", not "row 12 seats 7-9".
    const qty = new RegExp(`(?<!\\b(?:row|section|sec|seats?|aisle|block)\\s)(?<![$\\d.,]\\s?)\\b${NUMBER}\\s+(?:[a-z-]+\\s+){0,3}?(?:seats?|tickets?|admissions?|upgrades?|together|in a row)\\b`, 'i').exec(seg);
    const priceText = seg.slice(quote.index);
    const own = deliveryIn(seg) ?? sharedDelivery;
    const earlier = out.findIndex((o) => o.label === label);
    const push = (o: TextOffer) => (earlier >= 0 ? (out[earlier] = mergeOffer(out[earlier]!, o)) : out.push(o));
    push({
      ...entitlement,
      entry: entryTerm(seg),
      priceBasisStated: !!quote[2] || forTheBlock || forAllAfterFees,
      label,
      name: marks[i]!.name,
      alias: marks[i]!.alias ?? null,
      quantity: qty ? num(qty[1]!) : null,
      mustBuyAll: /\b(?:cannot|can't|can ?not|won't|will not|doesn't|does not)\s+(?:be\s+)?split\b|\b(?:must|have to|has to)\s+(?:all\s+)?be\s+(?:bought|purchased|sold)\b|\ball\s+\w+\s+must be\b|\bno splits?\b|\bsold (?:only )?(?:as a (?:block|set)|together)\b|\b(?:must|have to|has to)\s+buy\s+all\b|\brequires?\s+(?:you\s+to\s+)?(?:buy(?:ing)?|purchas(?:e|ing))\s+all\b|\ball\s+\w+\s+or\s+none\b|\bwon't sell (?:fewer|less)\b|\bmust\s+(?:purchase|buy|take)\s+(?:every|all|the whole)\b/i.test(seg),
      perTicketCents: isTotal ? null : cents,
      totalCents: isTotal ? cents : null,
      orderFeeCents: fee ? money(fee[1]!) : null,
      perTicketFeeCents: tFee ? money((tFee[1] ?? tFee[2])!) : null,
      // A total they quote for the order is what it costs ("Seller A is $360 total"), unless they say it's before fees.
      feeBasis: (ALL_IN.test(priceText) || !BEFORE_FEES.test(priceText) && /\b(?:both|all|these)(?:(?: copied)? (?:offers|prices|quotes))?[^.;:]{0,30}(?:fees included|include (?:all )?fees)\b/i.test(t)) ? 'all_in' : BEFORE_FEES.test(priceText) ? 'before_fees' : isTotal && /^\$\s?[\d,.]+\s*(?:in\s+)?total\b/i.test(priceText) && !fee && !tFee ? 'all_in' : 'unknown',
      noOtherCharges: /\bno (?:taxes? or )?(?:other|further|extra|additional) (?:charges|fees|costs)\b|\bno (?:taxes?|charges) or (?:other )?(?:charges|fees)\b|\bnothing else to pay\b/i.test(seg),
      accessible: says(seg, /\b(wheelchair|accessible|companion|ada)\b/i),
      obstructed: /\bunobstructed\b|\b(?:clear|full) view\b|\bnot obstructed\b/i.test(seg) ? false : /\b(?:obstructed|limited|partial|restricted)(?:\s+|-)view\b|\bview (?:is )?(?:obstructed|limited)\b|\bobstructed\b/i.test(seg) ? true : null,
      // "Two adjacent pairs" is two pairs, not four together; "separate singles scattered around" is neither.
      together: /\bnot together\b|\bsplit (?:up|across)\b|\b(?:separate|scattered|single)\s+(?:singles|seats)\b|\bsingles\b|\bscattered\b|\b(?:two|2|adjacent)\s+(?:adjacent\s+)?pairs\b/i.test(seg) ? false : /\b(?:together|adjacent)\b/i.test(seg) ? true : null,
      pairs: /\b(?:two|2)\s+(?:adjacent\s+)?pairs\b|\bin (?:adjacent )?pairs\b/i.test(seg),
      section: /\bsection\s+([A-Za-z0-9]+)\b/i.exec(seg)?.[1] ?? null,
      row: /\brow\s+([A-Za-z0-9]+)\b/i.exec(seg)?.[1] ?? null,
      deliveryStated: !!shared || DELIVERY.test(seg),
      deliveryMinutes: own ? toVenueMinutes(own.minutes, own.zone, venueTz) : null,
      // Quoted back in the zone they named, in our words: "10:30am Los Angeles time", not "10:30am LOS ANGELES time".
      deliveryAsWritten: own?.zone && toVenueMinutes(own.minutes, own.zone, venueTz) !== own.minutes ? `${timeLabel(own.minutes)} ${ZONE_NAME[ZONE_BEHIND_NY[own.zone.toLowerCase()]!] ?? own.zone} time` : null,
    });
  }
  // "Nothing else added on the first two", "compare the final totals I gave", "no other charges" said once for the
  // offers: the fees they listed are all there is (TGQA-R6 14). Only offers whose fees they gave are closed by it.
  const firstN = /\bnothing else (?:is )?(?:added|charged) on the first (two|three|four|2|3|4)\b/i.exec(t);
  const allClosed = !firstN && /\b(?:(?:compare|those are|these are) the final totals|final totals? (?:I gave|I pasted|are)|nothing else (?:is )?(?:added|charged)|no other (?:charges|fees) on (?:any|all|either|both))\b/i.test(t);
  if (firstN || allClosed) {
    const n = firstN ? (WORDS[firstN[1]!.toLowerCase()] ?? Number(firstN[1])) : out.length;
    out.forEach((o, i) => {
      if (i < n && (o.orderFeeCents !== null || o.perTicketFeeCents !== null || o.feeBasis === 'all_in')) out[i] = { ...o, noOtherCharges: true };
    });
  }
  // The one offer kept from a comparison: what they say about it after its own sentence is still about it ("Neither
  // seat is a wheelchair space. The seller now says mobile transfer is immediate", live R05-F1).
  if (minimum === 1 && out.length === 1 && out[0]!.deliveryMinutes === null) {
    const d = deliveryIn(t);
    if (d) out[0] = { ...out[0]!, deliveryStated: true, deliveryMinutes: toVenueMinutes(d.minutes, d.zone, venueTz) };
  }
  return out.length >= minimum ? out : [];
}

/** The offer's own amount: its total when it has one, else its per-ticket price. */
const amountOf = (o: TextOffer) => o.totalCents ?? o.perTicketCents;

/**
 * One offer, updated by a later mention of it. What the later mention states wins; what it leaves out keeps what
 * was said before: "The same two-seat Offer B is immediate transfer, all fees included" keeps B's $390 total, and
 * "C at $520 is over budget" doesn't turn C's $520 total into $520 a ticket (TGQA-R8 S05).
 */
export function mergeOffer(old: TextOffer, u: TextOffer): TextOffer {
  const ua = amountOf(u);
  const oa = amountOf(old);
  const sameAmount = ua !== null && (ua === oa || ua === old.totalCents || ua === old.perTicketCents);
  const takePrice = ua !== null && (!sameAmount || u.priceBasisStated && !(old.priceBasisStated && u.totalCents === null && old.totalCents === ua));
  const price = takePrice
    ? { totalCents: u.totalCents, perTicketCents: u.perTicketCents, feeBasis: u.feeBasis !== 'unknown' ? u.feeBasis : sameAmount ? old.feeBasis : 'unknown', orderFeeCents: u.orderFeeCents ?? (sameAmount ? old.orderFeeCents : null), perTicketFeeCents: u.perTicketFeeCents ?? (sameAmount ? old.perTicketFeeCents : null), priceBasisStated: u.priceBasisStated }
    : { totalCents: old.totalCents, perTicketCents: old.perTicketCents, feeBasis: u.feeBasis !== 'unknown' && ua !== null ? u.feeBasis : old.feeBasis, orderFeeCents: old.orderFeeCents ?? u.orderFeeCents, perTicketFeeCents: old.perTicketFeeCents ?? u.perTicketFeeCents, priceBasisStated: old.priceBasisStated };
  const delivery = u.deliveryMinutes !== null ? { deliveryStated: true, deliveryMinutes: u.deliveryMinutes, deliveryAsWritten: u.deliveryAsWritten } : { deliveryStated: old.deliveryStated || u.deliveryStated, deliveryMinutes: old.deliveryMinutes, deliveryAsWritten: old.deliveryAsWritten };
  return {
    ...old,
    ...price,
    ...delivery,
    admission: u.admissionStated ? u.admission : old.admission,
    admissionStated: old.admissionStated || u.admissionStated,
    productKind: u.productKind !== 'unknown' ? u.productKind : old.productKind,
    entry: u.entry ?? old.entry,
    // The latest name is the one they use now; the old one stays as another name for it.
    label: u.label,
    name: u.name,
    alias: u.label !== old.label ? old.label : u.alias ?? old.alias ?? null,
    quantity: u.quantity ?? old.quantity,
    mustBuyAll: old.mustBuyAll || u.mustBuyAll,
    noOtherCharges: old.noOtherCharges || u.noOtherCharges,
    accessible: old.accessible || u.accessible,
    obstructed: u.obstructed ?? old.obstructed,
    together: u.together ?? old.together,
    pairs: u.together !== null ? u.pairs : old.pairs || u.pairs,
    section: u.section ?? old.section,
    row: u.row ?? old.row,
  };
}

/** Same offer under either name: "Offer A (Gold)" is the Gold listing from before. */
export function sameOffer(a: TextOffer, b: TextOffer): boolean {
  const names = (o: TextOffer) => [o.label, o.alias].filter(Boolean) as string[];
  return names(a).some((n) => names(b).includes(n));
}

/**
 * Every offer in the thread, oldest first, one record each with its later mentions folded in. `fresh` keeps a new
 * set of offers from inheriting an older one's terms: only a restatement at the same amount carries over.
 */
export function offerHistory(messagesOldestFirst: string[], venueTz: string, opts: { fresh?: boolean } = {}): TextOffer[] {
  const out: TextOffer[] = [];
  messagesOldestFirst.forEach((m, idx) => {
    const last = idx === messagesOldestFirst.length - 1;
    for (const u of offersInText(m, venueTz, 1, { priceless: true })) {
      const i = out.findIndex((o) => sameOffer(o, u));
      if (i < 0) out.push(u);
      else if (last && opts.fresh && amountOf(u) !== null && amountOf(u) !== amountOf(out[i]!) && amountOf(u) !== out[i]!.totalCents) out[i] = u;
      else out[i] = mergeOffer(out[i]!, u);
    }
  });
  return out.filter((o) => amountOf(o) !== null || o.admissionStated);
}

/**
 * What the customer holds their offers to beyond access, view and budget, read across the thread oldest first
 * so the latest word wins: how many are going, whether they'll buy extra tickets, and the time the tickets must
 * arrive by. "I will not buy an extra ticket" then "I'm now happy to buy six even though only five of us are
 * going" ends as five going, six allowed (live M01 → M01-F1).
 */
export type PartyTerms = {
  attendees: number | null;
  extra: 'refused' | 'allowed' | null;
  maxBuy: number | null;
  /** When the tickets must be in their account, as the venue's local minutes on the event day. */
  deadlineMinutes: number | null;
  /** The zone they gave the deadline in ("New York"), when they named one: the reply speaks in it. */
  deadlineZone?: string | null;
  /**
   * How the party must sit, as they last said it: all together; in adjacent pairs, each child beside an adult
   * (TGQA-R8 S01); or anywhere ("scattered singles are now acceptable"). Null when they didn't say.
   */
  seating?: 'together' | 'pairs' | 'any' | null;
  night?: NightTiming | null;
  concertAdmission?: boolean;
};

/** "Each child must sit directly beside an adult; two adjacent adult-child pairs are fine." */
const PAIRS_OK = /\bone adult (?:must |can |will |has to )?sits? (?:with|beside|next to) each (?:child|kid)\b|\bsplit into (?:2|two) and (?:2|two)\b|\bin pairs\b|\beach adult (?:can |must )?sits? (?:beside|with|next to) (?:a|one) (?:child|kid)\b|\beach (?:child|kid) (?:must |has to |needs to |should )?(?:sits? )?(?:directly )?(?:beside|next to|with) an? (?:adult|parent)\b|\b(?:adjacent |two |2 )*(?:adult[- ](?:child|kid) )?pairs (?:are|is) (?:fine|ok|okay|acceptable|allowed)\b|\b(?:two|2) adjacent (?:adult[- ](?:child|kid) )?pairs\b[^.;]{0,30}\b(?:fine|ok|okay|acceptable|allowed)\b/i;
/** "We no longer require each child beside an adult", "scattered singles are now acceptable", "sitting separately". */
const ANY_SEATS = /\bno longer (?:require|need)\b[^.;]{0,40}\b(?:beside|next to|with an adult|adjacent)\b|\b(?:scattered |separate )?singles are (?:now )?(?:acceptable|fine|ok|okay|allowed)\b|\bsitting separately\b|\bsit (?:apart|separately)\b|\bseparate seats are (?:fine|ok|okay|acceptable)\b/i;
/** "We don't need to sit together": anywhere, unless the same message allows pairs. */
const NOT_TOGETHER = /\b(?:don'?t|do not) (?:need|have) to sit together\b|\b(?:do not|don'?t|no longer) (?:require|need) (?:all )?(?:\w+ )?(?:seats )?together\b/i;
/** "We must all sit together", "all five together", "four together please". */
const ALL_TOGETHER = /\b(?:must|need to|have to|want to) (?:all )?sit together\b|\ball (?:\w+ )?(?:of us )?together\b|\bseats? (?:all )?together\b/i;

export function partyTerms(messagesOldestFirst: string[], venueTz = 'America/New_York'): PartyTerms {
  const out: PartyTerms = { attendees: null, extra: null, maxBuy: null, deadlineMinutes: null, deadlineZone: null, seating: null };
  for (const raw of messagesOldestFirst) {
    const t = flat(raw);
    const going = new RegExp(`\\b(?:only|just)\\s+${NUMBER}\\s+of\\s+us\\b|\\b${NUMBER}\\s+of\\s+us\\s+(?:are\\s+|will\\s+be\\s+)?(?:going|attending)\\b|\\bthere\\s+(?:are|will be)\\s+${NUMBER}\\s+of\\s+us\\b|\\b(?:we are|we're)\\s+${NUMBER}\\b(?!\\s*(?:minutes?|hours?|years?))`, 'i').exec(t);
    if (going) out.attendees = num((going[1] ?? going[2] ?? going[3] ?? going[4])!);
    // Pairs are enough when each adult sits with a child: "we can split into 2 and 2 only if one adult sits with each
    // child", "each child must sit directly beside an adult; two adjacent adult-child pairs are fine" (TGQA-R6 18,
    // R8 S01). A later "we no longer require that" lifts it; the latest message wins.
    if (ANY_SEATS.test(t)) out.seating = 'any';
    else if (PAIRS_OK.test(t)) out.seating = 'pairs';
    else if (NOT_TOGETHER.test(t)) out.seating = 'any';
    else if (ALL_TOGETHER.test(t)) out.seating = 'together';
    const allowed = new RegExp(`\\b(?:happy|fine|ok|okay|willing|glad|prepared)\\s+(?:now\\s+)?to\\s+(?:buy|pay for)\\s+(?:an?\\s+)?(${NUMBER.slice(1, -1)}|extra|spare|sixth|seventh)\\b|\\b(?:the\\s+)?(?:extra|spare|sixth|seventh)\\s+(?:one|ticket)?\\s*can go unused\\b|\\bcan go unused\\b`, 'i').exec(t);
    const refused = /\b(?:will not|won't|do not want to|don't want to|not going to|refuse to)\s+(?:buy|pay for|purchase)(?:\s+or\s+\w+(?:\s+with)?)?\s+(?:an?\s+)?(?:extra|spare|sixth|seventh|additional|more than)\b|\bno extra tickets?\b|\bexactly\s+(?:one|two|three|four|five|six|seven|eight|\d{1,2})\s+(?:ordinary\s+)?(?:seats?|tickets?)\b/i.test(t);
    if (allowed) {
      out.extra = 'allowed';
      const n = allowed[1] ? WORDS[allowed[1].toLowerCase()] ?? (Number(allowed[1]) || null) : null;
      out.maxBuy = n;
    } else if (refused) {
      out.extra = 'refused';
      out.maxBuy = null;
    }
    // The time the tickets must arrive by: their own requirement, never an offer's delivery line.
    for (const s of sentences(t)) {
      // Said as their own deadline, it counts wherever it sits, even beside an offer: "My delivery deadline is 1PM
      // NEW YORK TIME, and you said Offer A arrives by 2PM" (TGQA-R8 S02), "I can now accept delivery until 3pm".
      const own = new RegExp(`\\b(?:deadline|cut-?off)\\s+(?:is|of|:)?\\s*(?:now\\s+|still\\s+)?${TIME}${ZONE}|\\b(?:accept|take)\\s+delivery\\s+(?:until|up to|by|as late as)\\s+${TIME}${ZONE}|\\b(?:need|must have|have to have)\\s+(?:them|the tickets|it|both|the seats|all of them)\\s+(?:in (?:my|our) account\\s+)?(?:by|before|no later than)\\s+${TIME}${ZONE}`, 'i').exec(s);
      if (own) {
        const raw = (own[1] ?? own[4] ?? own[7])!;
        const zone = own[2] ?? own[3] ?? own[5] ?? own[6] ?? own[8] ?? own[9] ?? null;
        const at0 = minutesOf(raw);
        if (at0 !== null) {
          out.deadlineMinutes = toVenueMinutes(at0, zone, venueTz);
          out.deadlineZone = zone ? ZONE_NAME[ZONE_BEHIND_NY[zone.toLowerCase()]!] ?? null : null;
          continue;
        }
      }
      if (/\b(?:offer|option|listing|seller)\s+[A-Z1-9]\b/i.test(s) || /^(?:All|Both|Each)\b/.test(s) || /(?:^|,\s)[A-E]\s+(?:is|at|has)\s/.test(s)) continue;
      if (!/\b(?:need|must|have to|deadline|leave|hard|require|set off|head out)\b/i.test(s)) continue;
      const m = new RegExp(`\\b(?:before|by|no later than)\\s+(?:we\\s+(?:leave|set off|head out)(?:\\s+home)?\\s+(?:at\\s+)?)?${TIME}${ZONE}|\\b(?:leave|set off|head out)(?:\\s+home)?\\s+at\\s+${TIME}${ZONE}|\\b${TIME}${ZONE}\\s+(?:delivery\\s+)?deadline\\b`, 'i').exec(s);
      const raw = m ? (m[1] ?? m[4] ?? m[7])! : null;
      const zone = m ? m[2] ?? m[3] ?? m[5] ?? m[6] ?? m[8] ?? m[9] ?? null : null;
      const at0 = raw ? minutesOf(raw) : null;
      const at = at0 === null ? null : toVenueMinutes(at0, zone, venueTz);
      if (at !== null && /\b(?:deliver\w*|tickets?|transfer\w*|arriv\w*|deadline|leave|set off|head out)\b/i.test(s)) {
        out.deadlineMinutes = at;
        out.deadlineZone = zone ? ZONE_NAME[ZONE_BEHIND_NY[zone.toLowerCase()]!] ?? null : null;
      }
    }
  }
  out.night = nightTiming(messagesOldestFirst);
  out.concertAdmission = /\bconcert|festival|house night\b/i.test(messagesOldestFirst.join(' '));
  return out;
}

/**
 * The whole-party total for an offer, worked out once: per-ticket times the tickets they'd actually buy, plus
 * a per-order fee once. `allIn` is what they told us, not something we checked. `tickets` is how many they'd
 * be paying for, which for a block that won't split is the whole block.
 */
export function offerTotal(o: TextOffer, partyQuantity: number): { cents: number; allIn: boolean; tickets: number } | null {
  const tickets = o.quantity !== null && (o.mustBuyAll || o.totalCents !== null) ? Math.max(o.quantity, partyQuantity) : partyQuantity;
  if (o.totalCents !== null) return { cents: o.totalCents + (o.orderFeeCents ?? 0), allIn: o.feeBasis === 'all_in' || (o.orderFeeCents !== null && o.noOtherCharges), tickets: o.quantity ?? partyQuantity };
  if (o.perTicketCents === null) return null;
  const base = (o.perTicketCents + (o.perTicketFeeCents ?? 0)) * tickets;
  if (o.orderFeeCents !== null || o.perTicketFeeCents !== null) return { cents: base + (o.orderFeeCents ?? 0), allIn: o.noOtherCharges || o.feeBasis === 'all_in', tickets };
  return { cents: base, allIn: o.feeBasis === 'all_in', tickets };
}

/**
 * How a price they quote was worded, near the amount: "$220 total including fees" is all-in by their account.
 * Null when the text doesn't say.
 */
export function statedFeeBasis(text: string, cents: number): 'all_in' | 'before_fees' | null {
  const t = flat(text);
  const re = /\$\s?(\d[\d,]*(?:\.\d{2})?)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const c = money(m[1]!);
    const after = t.slice(m.index, m.index + 60).split(/[.;!?](?:\s|$)/)[0]!;
    if (c !== cents && Math.abs(c - cents) > 1) continue;
    if (ALL_IN.test(after)) return 'all_in';
    if (BEFORE_FEES.test(after)) return 'before_fees';
  }
  return null;
}

/** "Offer B: 211" read as a section is the label, not the seat: keep the value. */
export function cleanSeatField(v: string | null): string | null {
  const s = v?.replace(/^\s*(?:offer|option|listing)\s+[A-Z0-9]+\s*[:\-–]\s*/i, '').trim();
  return s ? s : null;
}
