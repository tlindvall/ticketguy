/**
 * Offers a customer lays out in their own words ("Offer A says wheelchair-accessible spaces, $80 each including
 * fees. Offer B is ordinary seats together, section 211 row 12, $105 each including fees."). Each is one record
 * with what the text says about it and nothing more: these are their notes, not listings we've seen, and no
 * field of one offer is ever filled from another (post-#54 QA, R3-B01).
 */
export type TextOffer = {
  label: string;
  /** Tickets in the offer as described ("five together", "six ordinary unobstructed seats"); null when not said. */
  quantity: number | null;
  /** The seller won't split the block ("all six must be bought", "requires buying all six", "cannot split"). */
  mustBuyAll: boolean;
  perTicketCents: number | null;
  /** A total as stated for the whole offer. */
  totalCents: number | null;
  /** A charge for the whole order, added once ("plus $40 in fees for the whole order", "+ $48 per order"). */
  orderFeeCents: number | null;
  /** How the stated price was worded. A per-order fee on top of a before-fees price is kept apart. */
  feeBasis: 'all_in' | 'before_fees' | 'unknown';
  /** They say there's nothing else to pay ("no other charges"). */
  noOtherCharges: boolean;
  accessible: boolean;
  /** true: obstructed or limited view; false: said unobstructed; null: not said. */
  obstructed: boolean | null;
  together: boolean | null;
  section: string | null;
  row: string | null;
  /** Delivery is described for it (on the offer, or for all of them). */
  deliveryStated: boolean;
  /** When the tickets arrive, in minutes after midnight on the event day: 0 for immediate; null when not said. */
  deliveryMinutes: number | null;
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
/** A sentence that is the customer talking, not describing the offer: the offer ends there. */
const THEIR_WORDS = /^(?:I|I'm|I'd|We|We're|My|Our|Which|Please|These|Those|Neither|Can|Could|Should|What|How|Is|Are|Do|Does|Would|On price|Thanks|Also|Treat|Don't|Using|All (?:the )?offers|All (?:say|state|show|list)|All of (?:them|these)|Both (?:offers|of them|say|are|listings)|Each (?:offer|of them))\b/;
const DELIVERY = /\b(?:deliver(?:y|ed|s)?|transfer(?:red)?|mobile ticket|e-?ticket)\b/i;
const NEGATED = /\b(?:no|not|neither|nor|non|isn't|aren't|without|never)\b[^.;]{0,30}$/i;
const TIME = '(noon|midday|midnight|\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\.?)';

/**
 * One line, one space: text generated from an HTML email wraps at about 80 characters, and "no other\ncharges"
 * failed a phrase that "no other charges" passed (live X01, post-#55 QA).
 */
export function flat(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
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
function deliveryIn(seg: string): number | null {
  if (!DELIVERY.test(seg) && !/\binstant\b/i.test(seg)) return null;
  if (/\b(?:immediate(?:ly)?|instant(?:ly)?|right away|straight away)\b/i.test(seg)) return 0;
  const m = new RegExp(`\\b(?:deliver\\w*|transfer\\w*|arriv\\w*|sent|send)\\b[^.;]{0,40}?\\b(?:by|before|at)\\s+${TIME}`, 'i').exec(seg);
  return m ? minutesOf(m[1]!) : null;
}

export function timeLabel(minutes: number): string {
  if (minutes === 720) return 'noon';
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
}

export function offersInText(text: string): TextOffer[] {
  const t = flat(text);
  const marks = [...t.matchAll(/\b(?:[Oo]ffer|[Oo]ption|[Ll]isting)\s+([A-Z]|[1-9])\b/g)];
  if (marks.length < 2) return [];
  // Delivery said once for all of them ("All say transfer before noon").
  const shared = sentences(t).find((s) => /^(?:All|Both|Each)\b/.test(s) && !/\b(?:offer|option|listing)\s+[A-Z1-9]\b/i.test(s) && DELIVERY.test(s)) ?? null;
  const sharedMinutes = shared ? deliveryIn(shared) : null;
  const out: TextOffer[] = [];
  for (let i = 0; i < marks.length; i++) {
    const label = marks[i]![1]!;
    if (out.some((o) => o.label === label)) continue;
    const raw = t.slice(marks[i]!.index!, marks[i + 1]?.index ?? t.length);
    // The offer runs to the next label, or to the first sentence in their own voice.
    const kept: string[] = [];
    for (const s of sentences(raw)) {
      if (kept.length && THEIR_WORDS.test(s)) break;
      kept.push(s);
    }
    const seg = kept.join(' ');
    const fee = ORDER_FEE.exec(seg);
    const priceRe = /\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(each|a ticket|per ticket|\/ticket|apiece|pp|a seat|per seat|total|in total|for (?:both|all|the two|the pair))?/gi;
    let price: RegExpExecArray | null = null;
    for (let m = priceRe.exec(seg); m; m = priceRe.exec(seg)) {
      if (fee && m.index === fee.index) continue;
      price = m;
      break;
    }
    if (!price) continue;
    const cents = money(price[1]!);
    const isTotal = /total|for (both|all|the two|the pair)/i.test(price[2] ?? '');
    // "six ordinary unobstructed seats together", not "row 12 seats 7-9".
    const qty = new RegExp(`(?<!\\b(?:row|section|sec|seats?|aisle|block)\\s)(?<![$\\d.,]\\s?)\\b${NUMBER}\\s+(?:[a-z-]+\\s+){0,3}?(?:seats?|tickets?|together|in a row)\\b`, 'i').exec(seg);
    const priceText = seg.slice(price.index);
    const own = deliveryIn(seg);
    out.push({
      label,
      quantity: qty ? num(qty[1]!) : null,
      mustBuyAll: /\b(?:cannot|can't|can ?not|won't|will not|doesn't|does not)\s+(?:be\s+)?split\b|\b(?:must|have to|has to)\s+(?:all\s+)?be\s+(?:bought|purchased|sold)\b|\ball\s+\w+\s+must be\b|\bno splits?\b|\bsold (?:only )?(?:as a (?:block|set)|together)\b|\b(?:must|have to|has to)\s+buy\s+all\b|\brequires?\s+(?:you\s+to\s+)?(?:buy(?:ing)?|purchas(?:e|ing))\s+all\b|\ball\s+\w+\s+or\s+none\b|\bwon't sell (?:fewer|less)\b/i.test(seg),
      perTicketCents: isTotal ? null : cents,
      totalCents: isTotal ? cents : null,
      orderFeeCents: fee ? money(fee[1]!) : null,
      feeBasis: ALL_IN.test(priceText) ? 'all_in' : BEFORE_FEES.test(priceText) ? 'before_fees' : 'unknown',
      noOtherCharges: /\bno (?:other|further|extra|additional) (?:charges|fees|costs)\b|\bnothing else to pay\b/i.test(seg),
      accessible: says(seg, /\b(wheelchair|accessible|companion|ada)\b/i),
      obstructed: /\bunobstructed\b|\b(?:clear|full) view\b|\bnot obstructed\b/i.test(seg) ? false : /\b(?:obstructed|limited|partial|restricted)(?:\s+|-)view\b|\bview (?:is )?(?:obstructed|limited)\b|\bobstructed\b/i.test(seg) ? true : null,
      together: /\bnot together\b|\bsplit (?:up|across)\b/i.test(seg) ? false : /\b(?:together|adjacent)\b/i.test(seg) ? true : null,
      section: /\bsection\s+([A-Za-z0-9]+)\b/i.exec(seg)?.[1] ?? null,
      row: /\brow\s+([A-Za-z0-9]+)\b/i.exec(seg)?.[1] ?? null,
      deliveryStated: !!shared || DELIVERY.test(seg),
      deliveryMinutes: own ?? sharedMinutes,
    });
  }
  return out.length >= 2 ? out : [];
}

/**
 * What the customer holds their offers to beyond access, view and budget, read across the thread oldest first
 * so the latest word wins: how many are going, whether they'll buy extra tickets, and the time the tickets must
 * arrive by. "I will not buy an extra ticket" then "I'm now happy to buy six even though only five of us are
 * going" ends as five going, six allowed (live M01 → M01-F1).
 */
export type PartyTerms = { attendees: number | null; extra: 'refused' | 'allowed' | null; maxBuy: number | null; deadlineMinutes: number | null };

export function partyTerms(messagesOldestFirst: string[]): PartyTerms {
  const out: PartyTerms = { attendees: null, extra: null, maxBuy: null, deadlineMinutes: null };
  for (const raw of messagesOldestFirst) {
    const t = flat(raw);
    const going = new RegExp(`\\b(?:only|just)\\s+${NUMBER}\\s+of\\s+us\\b|\\b${NUMBER}\\s+of\\s+us\\s+(?:are\\s+|will\\s+be\\s+)?(?:going|attending)\\b`, 'i').exec(t);
    if (going) out.attendees = num((going[1] ?? going[2])!);
    const allowed = new RegExp(`\\b(?:happy|fine|ok|okay|willing|glad|prepared)\\s+(?:now\\s+)?to\\s+(?:buy|pay for)\\s+(?:an?\\s+)?(${NUMBER.slice(1, -1)}|extra|spare|sixth|seventh)\\b|\\b(?:the\\s+)?(?:extra|spare|sixth|seventh)\\s+(?:one|ticket)?\\s*can go unused\\b|\\bcan go unused\\b`, 'i').exec(t);
    const refused = /\b(?:will not|won't|do not want to|don't want to|not going to|refuse to)\s+(?:buy|pay for)\s+(?:an?\s+)?(?:extra|spare|sixth|seventh|additional|more than)\b|\bno extra tickets?\b|\bexactly\s+(?:one|two|three|four|five|six|seven|eight|\d{1,2})\s+(?:ordinary\s+)?(?:seats?|tickets?)\b/i.test(t);
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
      if (/\b(?:offer|option|listing)\s+[A-Z1-9]\b/i.test(s) || /^(?:All|Both|Each)\b/.test(s)) continue;
      if (!/\b(?:need|must|have to|deadline|leave|hard|require|set off|head out)\b/i.test(s)) continue;
      const m = new RegExp(`\\b(?:before|by)\\s+(?:we\\s+(?:leave|set off|head out)(?:\\s+home)?\\s+(?:at\\s+)?)?${TIME}|\\b(?:leave|set off|head out)(?:\\s+home)?\\s+at\\s+${TIME}|\\b${TIME}\\s+(?:delivery\\s+)?deadline\\b`, 'i').exec(s);
      const at = m ? minutesOf((m[1] ?? m[2] ?? m[3])!) : null;
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
  const base = o.perTicketCents * tickets;
  if (o.orderFeeCents !== null) return { cents: base + o.orderFeeCents, allIn: o.noOtherCharges || o.feeBasis === 'all_in', tickets };
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
