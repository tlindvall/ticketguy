import { formatUsd } from '@/lib/domain/money';
import { areaIntent, areaOf, type ShownOffer } from '@/lib/ai/listing-evidence';

/**
 * Questions about the priced rows a screenshot showed, answered in integer cents from the rows themselves: which of
 * the rows they name is cheaper for the party, whether one or each fits the cap they gave, whether tax is in it
 * (LAUNCH-03, gates A01–A04). Rows are named by their own labels ("tier 2 or tier 3?") or by the prices they quote;
 * two rows with the same price are still two rows. Nothing here says a row is still for sale.
 */

const QTY = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const qtyWord = (n: number) => QTY[n] ?? String(n);

/** "GA Ticket Price Tier 3: While Supplies Last" → "GA Ticket Price Tier 3": the row's name without the page's boilerplate. */
export const rowName = (label: string) => label.replace(/:\s*while supplies last\s*$/i, '').trim();

export type ShownQuestions = { whichCheaper: boolean; fits: boolean; afford: boolean; taxAsked: boolean; quotedRows: number[] };

export function shownQuestions(text: string): ShownQuestions {
  const t = text.replace(/[’‘]/g, "'");
  return {
    whichCheaper: /\bwhich (?:one |option |row |tier |of (?:them|these|those|the two) )?(?:is|would be|comes out|works out) (?:cheaper|less)\b|\bwhich (?:one |option |row |tier )?costs less\b|\b(?:tier|row|section|option) ?\w{0,3} or (?:tier|row|section|option) ?\w{0,3}\?/i.test(t),
    fits: /\b(?:does|do|would|will|is|are)\b(?:[^?.!]|\.\d){0,50}\bfit\b|\b(?:within|inside|under) (?:my|our|the) (?:budget|cap|\$)/i.test(t),
    afford: /\b(?:can|could) (?:we|i|us) afford\b|\bafford (?:either|any|both|them|these|those|it)\b|\b(?:either|any|both|neither) (?:of (?:them|these|those) )?(?:fit|work)s?\b|\bfit\b[^.?!]{0,30}\b(?:either|any|both)\b/i.test(t),
    taxAsked: /\b(?:include|includes|including|incl\.?|with)\s+(?:the\s+)?tax(?:es)?\b[^.!]*\?|\btax(?:es)?\s+(?:included|extra|on top)\b[^.!]*\?|\b(?:is|are) (?:the )?tax(?:es)? (?:included|in it|extra)/i.test(t),
    quotedRows: [...t.matchAll(/\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(?:each|a ticket|per ticket|\/ticket|ea\b)/gi)].map((m) => Math.round(Number(m[1]!.replace(/,/g, '')) * 100)),
  };
}

/**
 * The rows they mean, in the order they name them: by a tier or row number in the label ("tier 2"), by a label's own
 * words ("the balcony one"), or by a price they quote. Distinct rows stay distinct even at the same price.
 */
export function namedRows(text: string, rows: ShownOffer[]): ShownOffer[] {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const priced = rows.filter((o) => o.perTicketCents !== null);
  const hits: Array<{ at: number; row: ShownOffer }> = [];
  for (const m of t.matchAll(/\btier\s*(\d{1,2})\b/g)) {
    const row = priced.find((o) => new RegExp(`\\btier\\s*${m[1]}\\b`, 'i').test(o.label));
    if (row) hits.push({ at: m.index!, row });
  }
  for (const m of t.matchAll(/\$\s?(\d[\d,]*(?:\.\d{2})?)/g)) {
    const c = Math.round(Number(m[1]!.replace(/,/g, '')) * 100);
    const row = priced.find((o) => o.perTicketCents === c && !hits.some((h) => h.row === o));
    if (row) hits.push({ at: m.index!, row });
  }
  const seen = new Set<ShownOffer>();
  return hits.sort((a, b) => a.at - b.at).map((h) => h.row).filter((r) => (seen.has(r) ? false : (seen.add(r), true)));
}

/**
 * Their questions about the rows, answered: the parts in the order a reader needs them (comparison, cap, tax). Empty
 * when none of these was asked. `chosen` is the row already picked for them (their area, or the cheapest).
 */
export function shownPriceParts(a: { rows: ShownOffer[]; chosen: ShownOffer | null; quantity: number; budgetCents: number | null; text: string; thread?: string; beforeTaxes: boolean | null; asks?: Partial<ShownQuestions> }): string[] {
  const n = a.quantity;
  const t = shownQuestions(a.text);
  // A flag the caller already read only adds to what the words say; it never takes a question away.
  const q = { ...t, whichCheaper: t.whichCheaper || !!a.asks?.whichCheaper, fits: t.fits || !!a.asks?.fits, afford: t.afford || !!a.asks?.afford, taxAsked: t.taxAsked || !!a.asks?.taxAsked };
  const priced = a.rows.filter((o) => o.perTicketCents !== null);
  if (!priced.length) return [];
  const named = namedRows(a.text, priced);
  const out: string[] = [];
  const total = (o: ShownOffer) => o.perTicketCents! * n;
  const tierOr = named.length >= 2 && /\bor\b/i.test(a.text) && /\?/.test(a.text);
  if ((q.whichCheaper || tierOr) && named.length >= 2) {
    const [lo, hi] = named.slice(0, 2).sort((x, y) => x.perTicketCents! - y.perTicketCents!) as [ShownOffer, ShownOffer];
    out.push(lo.perTicketCents === hi.perTicketCents
      ? `${rowName(lo.label)} and ${rowName(hi.label)} cost the same: ${formatUsd(total(lo))} for ${qtyWord(n)} either way.`
      : `${rowName(lo.label)} is cheaper: ${formatUsd(total(lo))} for ${qtyWord(n)}, against ${formatUsd(total(hi))} for ${rowName(hi.label)}, so ${formatUsd(total(hi) - total(lo))} less.`);
  }
  const budget = a.budgetCents;
  if (q.afford && budget != null) {
    // "Either of these floor options": the rows they name, else the rows in the area they want, else all of them.
    const want = areaIntent(`${a.thread ?? ''}\n${a.text}`).want;
    const pool = named.length ? named : want && priced.some((o) => areaOf(o.label) === want) ? priced.filter((o) => areaOf(o.label) === want) : priced;
    const sorted = pool.slice().sort((x, y) => x.perTicketCents! - y.perTicketCents!);
    const fit = sorted.filter((o) => total(o) <= budget);
    const say = (o: ShownOffer) => `${rowName(o.label)} is ${formatUsd(total(o))} for ${qtyWord(n)}${total(o) > budget ? ` (${formatUsd(total(o) - budget)} over)` : ` (${formatUsd(budget - total(o))} under)`}`;
    const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
    out.push(!fit.length
      ? `${sorted.length === 1 ? 'No, it doesn’t fit' : sorted.length === 2 ? 'No, neither fits' : 'No, none of them fits'} your ${formatUsd(budget)}: ${list(sorted.map(say))}.`
      : fit.length === sorted.length
        ? `Yes, ${sorted.length === 1 ? 'it fits' : sorted.length === 2 ? 'both fit' : 'all of them fit'} your ${formatUsd(budget)}: ${list(sorted.map(say))}.`
        : `Only ${rowName(fit[0]!.label)} fits your ${formatUsd(budget)}: ${list(sorted.map(say))}.`);
  } else if (q.fits && budget != null) {
    const row = named[0] ?? a.chosen;
    if (row?.perTicketCents != null) {
      const t = total(row);
      out.push(t <= budget
        ? `Yes: ${formatUsd(t)} for ${qtyWord(n)} is within your ${formatUsd(budget)}${t < budget ? `, with ${formatUsd(budget - t)} to spare` : ''}.`
        : `No: ${formatUsd(t)} for ${qtyWord(n)} is ${formatUsd(t - budget)} over your ${formatUsd(budget)}.`);
    }
  }
  if (q.taxAsked && a.beforeTaxes) out.push('Those prices include fees but not tax, so tax is added on top at checkout.');
  else if (q.taxAsked) out.push('The screenshot doesn’t say whether tax is included, so check the total at checkout.');
  return out;
}
