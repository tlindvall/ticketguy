import { unglue } from '@/lib/domain/event-constraints';
/**
 * Offers a customer lays out in their own words ("Offer A says wheelchair-accessible spaces, $80 each including
 * fees. Offer B is ordinary seats together, section 211 row 12, $105 each including fees."). Each is one record
 * with what the text says about it and nothing more: these are their notes, not listings we've seen, and no
 * field of one offer is ever filled from another (post-#54 QA, R3-B01).
 */
export type TextOffer = {
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
const THEIR_WORDS = /^(?:I|I'm|I'd|We|We're|My|Our|Which|Please|These|Those|Neither|Can|Could|Should|What|How|Is|Are|Do|Does|Would|On price|Thanks|Also|Treat|Don't|Using|All (?:the )?offers|All (?:say|state|show|list)|All of (?:them|these)|Both (?:offers|of them|say|are|listings)|Each (?:offer|of them))\b/;
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

/**
 * Where each offer starts and what it is called: "Offer A"/"Option 2", or, when they name them another way,
 * "the green listing"/"the gold listing" or "First seller"/"Second seller" (post-#56 QA V01, V04). A name used
 * once is kept once; two or more names make a comparison.
 */
function offerMarks(t: string): Array<{ index: number; label: string; name: string }> {
  const lettered = [...t.matchAll(/\b([Oo]ffer|[Oo]ption|[Ll]isting|[Ss]eller)\s+([A-Z]|[1-9])\b/g)].map((m) => ({ index: m.index!, label: m[2]!, name: `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]}` }));
  if (new Set(lettered.map((m) => m.label)).size >= 2) return lettered;
  // Bare letters: "A is five ordinary seats…, B is six together…", "A at $360 arrives by 5pm, B at $390…" (TGQA-R6 07, 09).
  const bare = [...t.matchAll(/(?:^|[.;:!?]\s+|,\s+|\band\s+)([A-E])\s+(?:is|has|costs|at|for|gives|says|:)\s/g)].map((m) => ({ index: m.index! + m[0].indexOf(m[1]!), label: m[1]!, name: `Offer ${m[1]}` }));
  if (new Set(bare.map((m) => m.label)).size >= 2) return bare;
  // Named by the marketplace, each with its price: "StubHub $90 each plus $40…; TickPick $105 each…; Vivid Seats $95…".
  const sellers = [...t.matchAll(/\b(StubHub|TickPick|Vivid(?: Seats)?|SeatGeek|Gametime|Ticketmaster|AXS)\b(?=\s*(?:is\s+|now\s+|at\s+|:\s*|,\s*)?(?:shows\s+)?\$)/gi)].map((m) => {
    const name = m[1]!.toLowerCase().startsWith('vivid') ? 'Vivid Seats' : ({ stubhub: 'StubHub', tickpick: 'TickPick', seatgeek: 'SeatGeek', gametime: 'Gametime', ticketmaster: 'Ticketmaster', axs: 'AXS' } as Record<string, string>)[m[1]!.toLowerCase()]!;
    return { index: m.index!, label: name.toLowerCase(), name };
  });
  if (new Set(sellers.map((m) => m.label)).size >= 2) return sellers;
  const named = [
    ...[...t.matchAll(/\b[Tt]he\s+([a-z]+)\s+(listing|offer|option|seller|block)\b/g)].filter((m) => !NOT_A_NAME.test(m[1]!)).map((m) => ({ index: m.index!, label: m[1]!.toLowerCase(), name: `the ${m[1]!.toLowerCase()} ${m[2]}` })),
    ...[...t.matchAll(/\b(First|Second|Third|Fourth|Fifth|first|second|third|fourth|fifth)\s+(seller|listing|offer|option)\b/g)].filter((m) => ORDINAL.test(m[1]!)).map((m) => ({ index: m.index!, label: m[1]!.toLowerCase(), name: `the ${m[1]!.toLowerCase()} ${m[2]}` })),
  ].sort((a, b) => a.index - b.index);
  return new Set(named.map((m) => m.label)).size >= 2 ? named : [];
}

/** `minimum` 1 reads the one offer kept from a comparison ("ignore Offer A, only B"); the default needs two. */
export function offersInText(text: string, venueTz = 'America/New_York', minimum = 2): TextOffer[] {
  const t = flat(text);
  const marks = offerMarks(t);
  if (marks.length < 2) return [];
  // Delivery said once for all of them ("All say transfer before noon", "Both transfer immediately").
  // A clause counts too: "Same section and row; both offers say immediate transfer" (live V04).
  const shared = sentences(t).map((s) => /(?:^|[;:,]\s+)((?:All|Both|Each|all|both|each)\b.*)$/.exec(s)?.[1] ?? null).find((s) => s !== null && !/\b(?:offer|option|listing)\s+[A-Z1-9]\b/i.test(s) && DELIVERY.test(s)) ?? null;
  const sharedDelivery = shared ? deliveryIn(shared) : null;
  const out: TextOffer[] = [];
  for (let i = 0; i < marks.length; i++) {
    const label = marks[i]!.label;
    if (out.some((o) => o.label === label)) continue;
    // A later mention of an offer already read ("the gold listing is cheaper") is not a new offer, and doesn't cut it short.
    const nextNew = marks.slice(i + 1).find((m) => m.label !== label && !out.some((o) => o.label === m.label));
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
    if (!price) continue;
    const cents = money(price[1]!);
    // "four … seats together for $180 including all fees" is the block's price, not $180 a seat.
    const forTheBlock = !price[2] && /\bfor\s*$/i.test(seg.slice(Math.max(0, price.index - 6), price.index)) && /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|pair|\d{1,2})\s+(?:[a-z-]+\s+){0,3}?(?:seats?|tickets?|together|pairs|singles)\b/i.test(seg.slice(0, price.index));
    // "$190 all-in for both" and "$316 including fees in total" put the fee words between the price and "for both".
    const forAllAfterFees = !price[2] && /^\s*(?:all[- ]in|including (?:all |every )?(?:fees?|charges)|with fees)\s*,?\s*(?:for (?:both|all\b|the two|the pair|the (?:whole )?(?:order|block))|(?:in )?total)/i.test(seg.slice(price.index + price[0].length));
    const isTotal = forTheBlock || forAllAfterFees || /total|for (both|all|the two|the pair)/i.test(price[2] ?? '');
    // "six ordinary unobstructed seats together", not "row 12 seats 7-9".
    const qty = new RegExp(`(?<!\\b(?:row|section|sec|seats?|aisle|block)\\s)(?<![$\\d.,]\\s?)\\b${NUMBER}\\s+(?:[a-z-]+\\s+){0,3}?(?:seats?|tickets?|together|in a row)\\b`, 'i').exec(seg);
    const priceText = seg.slice(price.index);
    const own = deliveryIn(seg) ?? sharedDelivery;
    out.push({
      label,
      name: marks[i]!.name,
      quantity: qty ? num(qty[1]!) : null,
      mustBuyAll: /\b(?:cannot|can't|can ?not|won't|will not|doesn't|does not)\s+(?:be\s+)?split\b|\b(?:must|have to|has to)\s+(?:all\s+)?be\s+(?:bought|purchased|sold)\b|\ball\s+\w+\s+must be\b|\bno splits?\b|\bsold (?:only )?(?:as a (?:block|set)|together)\b|\b(?:must|have to|has to)\s+buy\s+all\b|\brequires?\s+(?:you\s+to\s+)?(?:buy(?:ing)?|purchas(?:e|ing))\s+all\b|\ball\s+\w+\s+or\s+none\b|\bwon't sell (?:fewer|less)\b|\bmust\s+(?:purchase|buy|take)\s+(?:every|all|the whole)\b/i.test(seg),
      perTicketCents: isTotal ? null : cents,
      totalCents: isTotal ? cents : null,
      orderFeeCents: fee ? money(fee[1]!) : null,
      perTicketFeeCents: tFee ? money((tFee[1] ?? tFee[2])!) : null,
      // A total they quote for the order is what it costs ("Seller A is $360 total"), unless they say it's before fees.
      feeBasis: ALL_IN.test(priceText) ? 'all_in' : BEFORE_FEES.test(priceText) ? 'before_fees' : isTotal && /^\$\s?[\d,.]+\s*(?:in\s+)?total\b/i.test(priceText) && !fee && !tFee ? 'all_in' : 'unknown',
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

/**
 * What the customer holds their offers to beyond access, view and budget, read across the thread oldest first
 * so the latest word wins: how many are going, whether they'll buy extra tickets, and the time the tickets must
 * arrive by. "I will not buy an extra ticket" then "I'm now happy to buy six even though only five of us are
 * going" ends as five going, six allowed (live M01 → M01-F1).
 */
export type PartyTerms = { attendees: number | null; extra: 'refused' | 'allowed' | null; maxBuy: number | null; deadlineMinutes: number | null; seating?: 'pairs' | null };

export function partyTerms(messagesOldestFirst: string[], venueTz = 'America/New_York'): PartyTerms {
  const out: PartyTerms = { attendees: null, extra: null, maxBuy: null, deadlineMinutes: null, seating: null };
  for (const raw of messagesOldestFirst) {
    const t = flat(raw);
    const going = new RegExp(`\\b(?:only|just)\\s+${NUMBER}\\s+of\\s+us\\b|\\b${NUMBER}\\s+of\\s+us\\s+(?:are\\s+|will\\s+be\\s+)?(?:going|attending)\\b|\\bthere\\s+(?:are|will be)\\s+${NUMBER}\\s+of\\s+us\\b|\\b(?:we are|we're)\\s+${NUMBER}\\b(?!\\s*(?:minutes?|hours?|years?))`, 'i').exec(t);
    if (going) out.attendees = num((going[1] ?? going[2] ?? going[3] ?? going[4])!);
    // Pairs are enough when each adult sits with a child: "we can split into 2 and 2 only if one adult sits with each
    // child", "one adult must sit with each child" (TGQA-R6 18).
    if (/\bone adult (?:must |can |will |has to )?sits? (?:with|beside|next to) each (?:child|kid)\b|\bsplit into (?:2|two) and (?:2|two)\b|\bin pairs\b|\beach adult (?:can |must )?sits? (?:beside|with|next to) (?:a|one) (?:child|kid)\b/i.test(t)) out.seating = 'pairs';
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
      if (/\b(?:offer|option|listing|seller)\s+[A-Z1-9]\b/i.test(s) || /^(?:All|Both|Each)\b/.test(s) || /(?:^|,\s)[A-E]\s+(?:is|at|has)\s/.test(s)) continue;
      if (!/\b(?:need|must|have to|deadline|leave|hard|require|set off|head out)\b/i.test(s)) continue;
      const m = new RegExp(`\\b(?:before|by|no later than)\\s+(?:we\\s+(?:leave|set off|head out)(?:\\s+home)?\\s+(?:at\\s+)?)?${TIME}${ZONE}|\\b(?:leave|set off|head out)(?:\\s+home)?\\s+at\\s+${TIME}${ZONE}|\\b${TIME}${ZONE}\\s+(?:delivery\\s+)?deadline\\b`, 'i').exec(s);
      const raw = m ? (m[1] ?? m[4] ?? m[7])! : null;
      const zone = m ? m[2] ?? m[3] ?? m[5] ?? m[6] ?? m[8] ?? m[9] ?? null : null;
      const at0 = raw ? minutesOf(raw) : null;
      const at = at0 === null ? null : toVenueMinutes(at0, zone, venueTz);
      if (at !== null && /\b(?:deliver\w*|tickets?|transfer\w*|arriv\w*|deadline|leave|set off|head out)\b/i.test(s)) out.deadlineMinutes = at;
    }
  }
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
