import { ALL_IN, flat } from './text-offers';
import { suppliedTrendQuestion } from './supplied-trend';

/**
 * Questions about figures the customer supplies (Research 2, R2-EVIDENCE-01): "singles fell from $90 to $60",
 * "yesterday $100 a ticket before fees, today $125 all-in", "listings went from 100 to 70". The answer is
 * arithmetic and a distinction, said first, with no event search and no event fields required: these can be
 * explained conditionally without knowing the artist or checking inventory.
 *
 * Each observation keeps its own units: when it was seen (a quote's "today" is not the date they want to go),
 * which basket (singles, a block of N together), the fee basis, and whether a count is of listings, orders or
 * tickets. Figures stay the customer's: nothing here is verified inventory, a forecast, or a buy/wait call.
 *
 * Abstains (returns null) unless one of the four families below is complete enough to answer, so ordinary
 * event requests and labelled offer comparisons ("Offer A … Offer B …") keep their own paths.
 */

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const COUNT = '(?<!\\$\\s?)(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d{1,2})';
const toCount = (w: string) => NUMBERS[w.toLowerCase()] ?? Number(w);
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const TEENS: Record<number, string> = { 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen' };
const word = (n: number) => WORDS[n] ?? String(n);
/** "thirty", "forty-two": counts said in words below 100, digits above. */
const spell = (n: number) => WORDS[n] ?? TEENS[n] ?? (n < 100 ? `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${WORDS[n % 10]}` : ''}` : String(n));

const EARLIER = /\b(?:yesterday|last (?:week|night|time)|earlier|originally|the old|my old|old quote|previous(?:ly)?|before(?!\s+(?:any\s+|the\s+)?fees?))\b|\bwas\b|\bwere\b/i;
const LATER = /\b(?:today|now|new quote|the new|latest|current(?:ly)?|this (?:morning|afternoon|evening))\b/i;
const BEFORE_FEES = /\b(?:before|plus|\+|excluding|excl\.?|not including|without)\s+(?:any\s+|the\s+)?fees?\b|\bfees?\s+(?:unknown|not (?:shown|included|listed)|on top|extra)\b|\bunknown fees?\b/i;
const PER_TICKET = /\b(?:each|per (?:ticket|seat|person)|a (?:ticket|seat)|apiece)\b|\/\s?(?:ticket|seat)\b/i;
const TOTAL = /\b(?:total|in total|for (?:both|the pair|all|the two|the order|the group|the five|the four|the three)|altogether)\b/i;
const OFFER_LABELS = /\b(?:offer|option|listing)\s+(?:[A-E]|[1-5])\b/i;
const FOLLOW_UP = /^(?:(?:ok|okay|thanks|so|and|hmm|right)[,!. ]+)*(?:what does (?:that|this) (?:mean|tell (?:us|me))|so (?:is|was|does) (?:it|that|this)|does (?:that|this) mean|can you explain|explain)\b[^.?!]*[.?!]?$/i;

type Money = { cents: number; index: number };
const money = (s: string): Money[] => [...s.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => ({ cents: Math.round(Number(m[1]!.replace(/,/g, '')) * 100), index: m.index! }));
const ints = (s: string): number[] => [...s.replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g, ' ').replace(/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b|\b\d+(?:\.\d+)?\s*%/gi, ' ').matchAll(/(?<![\w.])(\d{1,6})(?![\w.])/g)].map((m) => Number(m[1]));

function sentences(text: string): string[] {
  return flat(text).split(/(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z$])/).map((x) => x.trim()).filter(Boolean);
}
function clauses(sentence: string): string[] {
  return sentence.split(/[;,]\s*|\s+(?:but|while|whereas)\s+|\s+and\s+(?=(?:today|now|yesterday|the new|the old)\b)/i).map((x) => x.trim()).filter(Boolean);
}
/** Two values in one sentence, earlier first: "from $90 to $60", "$60 now, $90 yesterday". */
function ordered<T>(s: string, a: T, b: T): [T, T] {
  if (/\bfrom\b[^.]*\bto\b/i.test(s)) return [a, b];
  const later = LATER.exec(s)?.index;
  const earlier = EARLIER.exec(s)?.index;
  return later !== undefined && earlier !== undefined && later < earlier ? [b, a] : [a, b];
}
const when = (s: string): 'earlier' | 'later' | null => {
  const e = EARLIER.exec(s)?.index;
  const l = LATER.exec(s)?.index;
  if (e === undefined && l === undefined) return null;
  if (e === undefined) return 'later';
  if (l === undefined) return 'earlier';
  return e < l ? 'earlier' : 'later';
};

const SINGLES = /\bsingles?\b|\bsingle tickets?\b|\bindividual tickets?\b|\bone[- ]ticket (?:listings?|prices?)\b/i;
const GROUP = new RegExp(`\\b${COUNT}\\s+((?:(?:adjacent|connected|consecutive|side[- ]by[- ]side|upper[- ](?:tier|level|deck)|lower[- ](?:tier|level|bowl)|floor|balcony|mezzanine|orchestra)[\\s,]+(?:and\\s+)?)*)(?:seats|tickets)(\\s+together)?`, 'i');
const GROUP_WORD = /\b(?:group|block|together|adjacent|connected|side[- ]by[- ]side|in a row)\b/i;
const LISTINGS = /\b(?:active\s+)?listings?\b/i;
const ORDERS = /\b(\d{1,6})\s+orders?\b/i;
const SOLD_TICKETS = /\b(\d{1,6})\s+tickets?\b/i;
const FEE_AMOUNT = /\bfees?\b[^$.]{0,40}?\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s+(?:in|of|worth of)\s+(?:\w+\s+)?fees?\b/i;

type Quote = { cents: number; unit: 'ticket' | 'total' | null; basis: 'before_fees' | 'all_in'; seats: number | null; zone: string | null };

export type EvidenceFacts = {
  singles: { fromCents: number; toCents: number } | null;
  group: { quantity: number | null; descriptor: string | null; totals: Array<{ quantity: number | null; cents: number }>; mismatched: boolean } | null;
  fees: { quantity: number | null; old: Quote | null; next: Quote | null; oldFeesCents: number | null } | null;
  listings: { from: number; to: number } | null;
  sales: { orders: number | null; tickets: number | null; reported: boolean } | null;
  /** Ticket counts and dates that came from observations, so the brief doesn't take them as the request's. */
  observationDate: boolean;
  partyQuantity: number | null;
};

function partyQuantity(text: string): number | null {
  const m = new RegExp(`\\b(?:need|want|buying|for|get)\\s+${COUNT}\\s+(?:\\w+[- ]?\\w*\\s+){0,3}(?:seats|tickets)\\b|\\b${COUNT}\\s+of us\\b|\\b${COUNT}\\s+tickets\\b(?![^.]*\\b(?:sold|orders?)\\b)`, 'i').exec(text);
  const w = m?.[1] ?? m?.[2] ?? m?.[3];
  if (w) return toCount(w);
  return /\b(?:a pair|both of us|for both)\b/i.test(text) ? 2 : null;
}

/** Facts across the thread, in order: a later message adds to or replaces an earlier one, never erases it. */
export function evidenceFacts(messages: string[]): EvidenceFacts {
  const f: EvidenceFacts = { singles: null, group: null, fees: null, listings: null, sales: null, observationDate: false, partyQuantity: null };
  for (const raw of messages) {
    const q = partyQuantity(flat(raw));
    if (q) f.partyQuantity = q;
    for (const s of sentences(raw)) {
      const m = money(s);
      // "Today" beside a price or a count is when it was seen, not when they want to go.
      if (/\b(?:today|yesterday)\b/i.test(s) && (m.length > 0 || (LISTINGS.test(s) && ints(s).length > 0))) f.observationDate = true;
      // Singles: two prices for single tickets.
      // A price change needs a change: "from $90 to $60", "$90 → $60", or an earlier and a later price. A list of
      // options side by side ("lottery for $50, or a pair for $220") is not one basket at two times (R1-A02).
      const change = /\bfrom\s+\$?\d[\d,]*\s+(?:\w+\s+){0,2}to\s+\$?\d|\d\s*(?:→|->)\s*\$?\d/i.test(s) || (EARLIER.test(s) && LATER.test(s));
      const multi = [...s.matchAll(new RegExp(`\\b${COUNT}\\s+(?:[a-z-]+\\s+){0,3}(?:seats|tickets)\\b`, 'gi'))].some((x) => toCount(x[1]!) >= 2);
      const mixedFees = BEFORE_FEES.test(s) && ALL_IN.test(s);
      if (SINGLES.test(s) && m.length >= 2 && !multi && !mixedFees && change) {
        const [a, b] = ordered(s, m[0]!.cents, m[1]!.cents);
        f.singles = { fromCents: a, toCents: b };
      }
      // A group basket: "five adjacent upper-tier seats", with or without its own prices.
      const g = GROUP.exec(s);
      if (g && toCount(g[1]!) >= 2 && (GROUP_WORD.test(s) || g[2]?.trim())) {
        const descriptor = [g[2]?.replace(/[\s,]+(?:and\s+)?/g, ' ').trim(), g[3] ? 'together' : ''].filter(Boolean).join(' ') || null;
        f.group = { quantity: toCount(g[1]!), descriptor: descriptor ?? f.group?.descriptor ?? null, totals: f.group?.totals ?? [], mismatched: f.group?.mismatched ?? false };
      }
      if (!SINGLES.test(s) && /\bgroup\b|\bblock\b|\btogether\b|\badjacent\b/i.test(s) && m.length >= 2 && !BEFORE_FEES.test(s) && !ALL_IN.test(s) && change) {
        // Totals for the group, each tagged with its own seat count when the clause says one.
        const parts = clauses(s).flatMap((c) => money(c).map((x) => ({ c, cents: x.cents })));
        const tagged = parts.map((p) => {
          const n = new RegExp(`\\b${COUNT}\\s+(?:\\w+[- ]?\\w*\\s+){0,2}(?:seats|tickets)\\b`, 'i').exec(p.c)?.[1];
          return { quantity: n ? toCount(n) : null, cents: p.cents, perTicket: PER_TICKET.test(p.c) };
        });
        const [a, b] = ordered(s, tagged[0]!, tagged[1]!);
        const base = f.group?.quantity ?? f.partyQuantity;
        const total = (t: typeof a) => (t.perTicket && (t.quantity ?? base) ? t.cents * (t.quantity ?? base)! : t.cents);
        const qa = a.quantity ?? base;
        const qb = b.quantity ?? base;
        f.group = { quantity: f.group?.quantity ?? qb ?? null, descriptor: f.group?.descriptor ?? null, totals: [{ quantity: qa, cents: total(a) }, { quantity: qb, cents: total(b) }], mismatched: qa !== null && qb !== null && qa !== qb };
      }
      // Fee basis: each clause is one quote, with its own time, basis and unit.
      for (const c of clauses(s)) {
        const cm = money(c);
        const fee = FEE_AMOUNT.exec(c);
        if (fee && !BEFORE_FEES.test(c) && !ALL_IN.test(c)) {
          const cents = Math.round(Number((fee[1] ?? fee[2])!.replace(/,/g, '')) * 100);
          const perTicket = PER_TICKET.test(c);
          const qty = f.fees?.quantity ?? f.partyQuantity;
          f.fees = { quantity: qty, old: f.fees?.old ?? null, next: f.fees?.next ?? null, oldFeesCents: perTicket && qty ? cents * qty : cents };
          continue;
        }
        if (!cm.length) continue;
        const basis = BEFORE_FEES.test(c) ? 'before_fees' : ALL_IN.test(c) ? 'all_in' : null;
        const t = when(c);
        if (!basis || !t) continue;
        const unit = PER_TICKET.test(c) ? 'ticket' : TOTAL.test(c) ? 'total' : null;
        const n = new RegExp(`\\b${COUNT}\\s+(?:[a-z-]+\\s+){0,3}(?:seats|tickets)\\b`, 'i').exec(c)?.[1];
        const seats = /\b(?:a |one )?single\b/i.test(c) ? 1 : n ? toCount(n) : null;
        const zone = /\b(upper|lower)[- ](?:level|tier|deck|bowl)\b/i.exec(c)?.[1]?.toLowerCase() ?? null;
        const quote: Quote = { cents: cm[0]!.cents, unit: unit ?? (seats === 1 ? 'total' : null), basis, seats, zone };
        const prev = f.fees ?? { quantity: f.partyQuantity, old: null, next: null, oldFeesCents: null };
        f.fees = { ...prev, quantity: prev.quantity ?? f.partyQuantity, [t === 'earlier' ? 'old' : 'next']: quote };
      }
      // Listing counts: "active listings fell from 100 to 70".
      // A change needs a change: "from 100 to 70", "100 → 70", or an earlier and a later count.
      if (LISTINGS.test(s) && !m.length && change) {
        const n = ints(s);
        if (n.length >= 2) {
          const [a, b] = ordered(s, n[0]!, n[1]!);
          f.listings = { from: a, to: b };
        }
      }
      // A sales report: orders and tickets, the customer's figures. Their question ("does that mean 30 tickets
      // sold?") is not a report.
      if (/\?\s*$/.test(s)) continue;
      const o = ORDERS.exec(s);
      const tk = /\b(?:sold|sales?|orders?)\b/i.test(s) ? SOLD_TICKETS.exec(s.replace(ORDERS, '')) : null;
      if (o || (tk && /\bsold\b/i.test(s))) f.sales = { orders: o ? Number(o[1]) : f.sales?.orders ?? null, tickets: tk ? Number(tk[1]) : f.sales?.tickets ?? null, reported: /\b(?:report|data|says|shows|according|saw|heard|told)\b/i.test(s) || !!f.sales?.reported };
    }
  }
  if (f.fees && f.fees.quantity === null) f.fees.quantity = f.partyQuantity;
  return f;
}

const usd = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: c % 100 ? 2 : 0, minimumFractionDigits: c % 100 ? 2 : 0 }).format(c / 100);
const pct = (part: number, of: number) => `${Number(((Math.abs(part) / of) * 100).toPrecision(3))}%`;
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

export type EvidenceAnswer = { lead: string; items: string[]; nextStep: string | null; kinds: string[] };

/** The answer to their latest question about supplied figures, or null when this isn't one. */
export function suppliedEvidenceAnswer(messages: string[]): EvidenceAnswer | null {
  const latest = flat(messages.at(-1) ?? '');
  if (!latest || OFFER_LABELS.test(messages.map(flat).join(' '))) return null;
  // Mismatched baskets put as a trend question keep their own, narrower answer.
  if (suppliedTrendQuestion(messages)) return null;
  const all = evidenceFacts(messages);
  const prior = evidenceFacts(messages.slice(0, -1));
  const now = evidenceFacts([messages.at(-1) ?? '']);
  const contributes = !!(now.singles || now.group?.totals.length || now.fees?.old || now.fees?.next || now.fees?.oldFeesCents !== null && now.fees?.oldFeesCents !== undefined || now.listings || now.sales);
  // A reply with no new figure is theirs to ask about the old ones ("what does that mean?"), never a new request.
  if (!contributes && !(FOLLOW_UP.test(latest) && hasFamily(prior))) return null;
  if (!hasFamily(all)) return null;

  // R2-01: a group total, or singles beside a group that has none.
  if (all.group && all.group.totals.length === 2) {
    const g = all.group;
    if (g.mismatched) return { lead: 'Those two totals are for different numbers of seats, so they can’t show a price change.', items: [`One is for ${word(g.totals[0]!.quantity!)} seats and the other for ${word(g.totals[1]!.quantity!)}. A change in the size of the block changes the total whatever the market does.`, 'For a price change, I’d need two totals for the same number of seats, in the same area, with the same fee basis.'], nextStep: null, kinds: ['group_mismatch'] };
    const a = g.totals[0]!;
    const b = g.totals[1]!;
    const d = b.cents - a.cents;
    const n = g.quantity;
    const who = n ? `your ${word(n)}-seat group` : 'your group';
    const lead = d === 0 ? `For ${who}, the supplied total didn’t change: ${usd(a.cents)} both times.` : `For ${who}, the supplied total went ${d > 0 ? 'up' : 'down'} ${usd(Math.abs(d))}: ${usd(a.cents)} to ${usd(b.cents)}.`;
    const items: string[] = [];
    if (d !== 0) items.push(`That’s ${pct(d, a.cents)} ${d > 0 ? 'above' : 'below'} the earlier quote${all.singles ? `, even though singles ${all.singles.toCents < all.singles.fromCents ? 'got cheaper' : 'went up'} over the same time (${usd(all.singles.fromCents)} to ${usd(all.singles.toCents)})` : ''}.${all.singles ? ` Singles and ${n ? `blocks of ${word(n)}` : 'group blocks'} are different baskets, so they can move in different directions.` : ''}`);
    items.push('It tells us what changed between these two quotes; it doesn’t tell us what happens next or whether those seats are still there.');
    return { lead, items, nextStep: null, kinds: ['group_change'] };
  }
  if (all.singles) {
    const s = all.singles;
    const d = s.toCents - s.fromCents;
    const lead = d === 0 ? `Singles didn’t move: ${usd(s.fromCents)} both times.` : `Singles ${d < 0 ? 'fell' : 'rose'} ${usd(Math.abs(d))}, from ${usd(s.fromCents)} to ${usd(s.toCents)} (${pct(d, s.fromCents)} ${d < 0 ? 'lower' : 'higher'}).`;
    const g = all.group;
    const groupName = g?.quantity ? `${word(g.quantity)}${g.descriptor ? ` ${g.descriptor}` : ''} seats` : null;
    const items = [
      groupName
        ? `That’s single tickets only. It doesn’t tell us what ${groupName} cost: a block of ${word(g!.quantity!)} together is a different basket, and I have no prices for it at either time.`
        : 'That’s single tickets only, so it doesn’t tell us what a group seated together would cost.',
      'These are the two prices you sent; I haven’t checked them or what’s available now, and a past move doesn’t say where prices go next.',
    ];
    return { lead, items, nextStep: groupName ? `If you have the total for the ${groupName} at both times, send it and I’ll compare like with like.` : null, kinds: ['singles_change'] };
  }

  // R2-03: an old quote before fees against a new one with fees included.
  if (all.fees?.old && all.fees.next) {
    const f = all.fees;
    // A single upper-level seat against five lower-level seats is not one basket at two times.
    const o = f.old!;
    const x = f.next!;
    if ((o.seats !== null && x.seats !== null && o.seats !== x.seats) || (o.zone !== null && x.zone !== null && o.zone !== x.zone)) {
      return { lead: 'Those two quotes are for different seats, so they can’t show whether prices went up or down.', items: [`${o.seats !== x.seats && o.seats !== null && x.seats !== null ? `One is for ${word(o.seats)} seat${o.seats === 1 ? '' : 's'} and the other for ${word(x.seats)}` : 'They’re in different parts of the venue'}${o.basis !== x.basis ? ', and only one includes fees' : ''}. A different number of seats, area or fee basis changes the price whatever the market does.`, 'For a price change, I’d need two quotes for the same seats, in the same area, with the same fee basis.'], nextStep: null, kinds: ['basket_mismatch'] };
    }
    const q = f.quantity;
    const unitOf = (x: NonNullable<typeof f.old>, other: NonNullable<typeof f.old>) => x.unit ?? other.unit;
    const total = (x: NonNullable<typeof f.old>, other: NonNullable<typeof f.old>) => (unitOf(x, other) === 'total' ? x.cents : q ? x.cents * q : null);
    const oldBase = total(f.old!, f.next!);
    const nextTotal = total(f.next!, f.old!);
    if (oldBase === null || nextTotal === null) return null;
    const party = q ? ` for ${word(q)}` : '';
    const describe = (x: NonNullable<typeof f.old>, t: number, other: NonNullable<typeof f.old>) => `${unitOf(x, other) === 'ticket' && q && q > 1 ? `${usd(x.cents)} a ticket, so ${usd(t)}${party}` : usd(t)}`;
    if (f.old!.basis === 'before_fees' && f.next!.basis === 'all_in') {
      if (f.oldFeesCents !== null) {
        const oldTotal = oldBase + f.oldFeesCents;
        const d = nextTotal - oldTotal;
        const lead = d === 0 ? 'The two quotes come to the same, with fees included in both totals.' : `Today’s ${q === 2 ? 'pair' : 'quote'} is ${usd(Math.abs(d))} ${d < 0 ? 'cheaper' : 'more expensive'}, with fees included in both totals.`;
        return { lead, items: [`Yesterday was ${usd(oldBase)} plus ${usd(f.oldFeesCents)} in fees: ${usd(oldTotal)}. Today is ${usd(nextTotal)}${d === 0 ? '' : `, ${pct(d, oldTotal)} ${d < 0 ? 'below' : 'above'} yesterday’s complete price`}.`, 'I’m comparing your figures here; availability hasn’t been checked.'], nextStep: null, kinds: ['fee_total_compared'] };
      }
      const breakEven = nextTotal - oldBase;
      if (breakEven <= 0) return { lead: `Yesterday’s quote was cheaper whatever its fees: ${usd(oldBase)} before fees against ${usd(nextTotal)} with fees included.`, items: ['I’m comparing your figures here; availability hasn’t been checked.'], nextStep: null, kinds: ['fee_unknown'] };
      return {
        lead: `It depends on yesterday’s fees: today’s ${usd(nextTotal)} is cheaper only if they came to more than ${usd(breakEven)}.`,
        items: [
          `Yesterday: ${describe(f.old!, oldBase, f.next!)} before fees, plus fees I don’t know. Today: ${describe(f.next!, nextTotal, f.old!)} with fees included.`,
          `If yesterday’s fees for the order were more than ${usd(breakEven)}, today’s quote is cheaper; at exactly ${usd(breakEven)} they tie; under that, yesterday’s was cheaper.`,
          'This is arithmetic on the figures you sent; I haven’t checked either price or what’s available now.',
        ],
        nextStep: 'If you have yesterday’s fee total, send it and I’ll give you the exact difference.',
        kinds: ['fee_unknown'],
      };
    }
    if (f.old!.basis === f.next!.basis) {
      const d = nextTotal - oldBase;
      const basis = f.old!.basis === 'all_in' ? 'with fees included in both' : 'both before fees';
      return { lead: d === 0 ? `The two quotes are the same, ${basis}: ${usd(oldBase)}.` : `Today’s quote is ${usd(Math.abs(d))} ${d < 0 ? 'cheaper' : 'more expensive'}, ${basis}: ${usd(oldBase)} to ${usd(nextTotal)}.`, items: [...(d === 0 ? [] : [`That’s ${pct(d, oldBase)} ${d < 0 ? 'lower' : 'higher'}.`]), ...(f.old!.basis === 'before_fees' ? ['Fees could change the order, so compare the checkout totals before you decide.'] : []), 'I’m comparing your figures here; availability hasn’t been checked.'], nextStep: null, kinds: ['fee_same_basis'] };
    }
    return { lead: `Yesterday’s quote included fees and today’s doesn’t, so today’s ${usd(nextTotal)} before fees isn’t comparable with yesterday’s ${usd(oldBase)} yet.`, items: [`Today’s is cheaper only if its fees come to less than ${usd(Math.max(0, oldBase - nextTotal))}.`, 'I’m comparing your figures here; availability hasn’t been checked.'], nextStep: 'If you can see today’s total at checkout, send it and I’ll give you the exact difference.', kinds: ['fee_unknown'] };
  }

  // R2-02: listing counts, and a separate sales report when there is one.
  if (all.listings) {
    const l = all.listings;
    const d = l.to - l.from;
    const n = Math.abs(d);
    const unitWord = (x: number) => (x === 1 ? 'listing' : 'listings');
    if (all.sales && (all.sales.orders !== null || all.sales.tickets !== null)) {
      const s = all.sales;
      const what = [s.orders !== null ? `${s.orders} order${s.orders === 1 ? '' : 's'}` : null, s.tickets !== null ? `${s.tickets} ticket${s.tickets === 1 ? '' : 's'}` : null].filter(Boolean).join(' covering ');
      return {
        lead: d < 0 ? `${cap(spell(n))} fewer ${unitWord(n)} doesn’t mean ${spell(n)} sales.` : 'More listings doesn’t tell us anything about sales.',
        items: [
          `${s.reported ? 'Your separate report records' : 'The figures you sent record'} ${what}. If ${s.reported ? 'it’s' : 'they’re'} right, that’s what sold; it doesn’t account for all ${n} ${unitWord(n)} that came down, which held an unknown number of tickets, so we don’t know why the rest went.`,
          'Neither figure shows demand is rising: that needs sales over time from the same source, counted the same way.',
          s.reported ? 'The report is yours; I haven’t checked where it comes from or how it counts.' : 'Those figures are yours; I haven’t checked where they come from or how they count.',
        ],
        nextStep: null,
        kinds: ['listings_vs_sales'],
      };
    }
    if (d === 0) return { lead: `The listing count didn’t change: ${l.from} both times.`, items: ['That says nothing either way about sales: listings can sell and be replaced.', 'These are the counts you sent; I haven’t checked them.'], nextStep: null, kinds: ['listings_change'] };
    return {
      lead: `Listings ${d < 0 ? 'fell' : 'rose'} by ${n}, from ${l.from} to ${l.to} (${pct(d, l.from)} ${d < 0 ? 'fewer' : 'more'}). That’s a count of listings, not of tickets, orders or sales.`,
      items: [
        d < 0
          ? 'A listing can hold several tickets, and listings come down for reasons other than a sale here: a seller pulls one, relists it at a new price, or sells it elsewhere. So the drop doesn’t say how many tickets sold, or whether demand is rising.'
          : 'New listings can be new sellers or relisted tickets, so the rise doesn’t say demand is falling.',
        'These are the counts you sent; I haven’t checked them.',
      ],
      nextStep: d < 0 ? 'If you have sales figures that record orders, send them and I’ll separate them from the listing change.' : null,
      kinds: ['listings_change'],
    };
  }
  if (all.sales && (all.sales.orders !== null || all.sales.tickets !== null)) {
    const s = all.sales;
    return { lead: `${s.reported ? 'Your figures record' : 'Taking your figures as given, that’s'} ${[s.orders !== null ? `${s.orders} order${s.orders === 1 ? '' : 's'}` : null, s.tickets !== null ? `${s.tickets} ticket${s.tickets === 1 ? '' : 's'}` : null].filter(Boolean).join(' covering ')} sold.`, items: ['On its own that doesn’t show demand is rising or falling: that needs sales over time from the same source.', 'I haven’t checked where those figures come from or how they count sales.'], nextStep: null, kinds: ['sales_only'] };
  }
  return null;
}

function hasFamily(f: EvidenceFacts): boolean {
  return !!(f.singles || (f.group && f.group.totals.length === 2) || (f.fees?.old && f.fees.next) || f.listings || (f.sales && (f.sales.orders !== null || f.sales.tickets !== null)));
}
