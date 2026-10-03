import { formatUsd } from '@/lib/domain/money';
import { actsOf, areaIntent, areaOf, chooseShownOffer, distinctActs, type ListingFields, type PageProduct } from '@/lib/ai/listing-evidence';
import { rowName, shownPriceParts, shownQuestions } from './shown-prices';

/**
 * Questions about what the customer's screenshots show, answered from those screenshots before (or without) any
 * catalog match or live inventory (LAUNCH-01/02/04, gates A05–A09): doors and show times, standing or seated, which
 * product is the concert ticket, whether a multi-night ticket splits, a sold-out page and its packages, the shown
 * prices against their cap, and two shows kept apart. A screenshot is what the page showed when it was taken: it is
 * never said to prove anything is on sale now.
 */

export type EvidenceItem = { fields: ListingFields; observedAt: Date; messageId: string };
export type CoverageStatus = 'answered' | 'needs_clarification' | 'unsupported' | 'operational_follow_up';
export type Coverage = { question: string; status: CoverageStatus };
export type EvidenceAnswer = { lead: string; items: string[]; coverage: Coverage[] };

export type EvidenceAsks = { times: boolean; admission: boolean; product: boolean; split: boolean; soldOut: boolean; explain: boolean; prices: boolean };

const T = (s: string) => s.replace(/[’‘]/g, "'");

/** Which of their questions a screenshot can answer, from their words. */
export function evidenceAsks(text: string): EvidenceAsks {
  const t = T(text);
  const sq = shownQuestions(t);
  return {
    times: /\bdoors?\b|\bshow ?time\b|\bactual show\b|\bwhat time\b|\bwhen (?:does|do) (?:it|the show|they) (?:start|begin|go on)\b|\bstart(?:s|ing)? at\b|\bwhen should (?:we|i) (?:arrive|get there)\b/i.test(t),
    admission: /\bseats? or standing\b|\bstanding or seat|\b(?:is|are) (?:it|they|the \w+(?: tickets?)?) (?:standing|seated|general admission|ga)\b|\bstanding room\b[^.]*\?|\bassigned seats?\b/i.test(t),
    product: /\bwhich (?:of these|one|should i|do i|to)\b[^.?!]{0,60}\b(?:click|pick|choose|buy|start|get)\b|\bwhich of these\b|\bnormal (?:concert|ticket|show)\b|\bno extras\b|\bjust the (?:normal|regular|concert)\b|\b(?:suite|2[- ]day|two[- ]day|multi[- ]day)\b[^.?!]{0,60}\?/i.test(t),
    split: /\bother night\b|\bcovers both\b|\bboth nights\b|\bsplit\b|\bshare (?:it|the ticket)\b|\b(?:i|we)'?d go\b[^.?!]{0,60}\b(?:they|she|he)'?d go\b/i.test(t),
    soldOut: /\bsold out\b|\bhotel (?:package|bundle)\b|\bhave to buy a (?:hotel|package|bundle)\b|\banother way\b|\bonly way\b/i.test(t),
    explain: /\bexplain\b|\bwhat (?:each|is|are|does) (?:\w+ )?(?:screenshot|page|this|these|it)\b[^.?!]{0,30}\b(?:offer|show|mean)|\bwhat (?:each|they) (?:is|are) offering\b|\bwhat does (?:this|it) mean\b/i.test(t),
    prices: sq.whichCheaper || sq.fits || sq.afford || sq.taxAsked || /\bcheapest\b|\blowest\b|\bhow much\b|\bwhat would (?:we|i) pay\b|\bcost (?:for|us)\b/i.test(t),
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "October 8", "Oct 8th", "10/8": the month and day they mean, if they gave one. */
function askedMonthDay(text: string): string | null {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(text);
  if (m) return `${String(MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  const n = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/.exec(text);
  return n ? `${n[1]!.padStart(2, '0')}-${n[2]!.padStart(2, '0')}` : null;
}
const dayLabel = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));
const timeLabel = (hhmm: string) => {
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3, 5);
  return `${h % 12 === 0 ? 12 : h % 12}${m === '00' ? '' : `:${m}`}${h < 12 ? 'am' : 'pm'}`;
};
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const qtyWord = (n: number) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][n] ?? String(n);

/** The single-show product for the day they mean, from the screenshot's own rows; null when it shows none. */
function singleFor(f: ListingFields, monthDay: string | null): PageProduct | null {
  const singles = (f.products ?? []).filter((p) => p.kind === 'single_show' && !p.promoted);
  return (monthDay ? singles.find((p) => p.date?.slice(5) === monthDay) : null) ?? (singles.length === 1 ? singles[0]! : null);
}
const isMulti = (p: PageProduct) => p.kind === 'multi_day' || /\b(?:[2-9]|two|three)[- ]day\b|\bcannot split\b/i.test(p.label);
const splitTerm = (p: PageProduct) => [...p.terms, p.label].map((x) => /\bcannot split[^,;)]*|\bcan'?t (?:be )?split[^,;)]*|\bnon[- ]?transferable\b/i.exec(x)?.[0]).find(Boolean) ?? null;

/** What each screenshot is offering, for two different shows: kept apart, one line each (A08). */
function describe(f: ListingFields): string {
  const ev = (f.events ?? []).find((e) => !e.promoted);
  const name = f.eventName ?? ev?.name ?? (f.products ?? []).find((p) => !p.promoted)?.label ?? 'This one';
  const where = f.venue ?? ev?.venue ?? null;
  const date = f.eventDate ?? ev?.date ?? null;
  const times = f.doorsTime && f.showTime ? `doors ${timeLabel(f.doorsTime)}, show ${timeLabel(f.showTime)}` : f.eventTime ? timeLabel(f.eventTime) : null;
  const head = `${name}${where ? ` at ${where}` : ''}${date ? `, ${dayLabel(date)}` : ''}${times ? ` (${times})` : ''}`;
  const rows = (f.offers ?? []).filter((o) => o.perTicketCents !== null).sort((a, b) => a.perTicketCents! - b.perTicketCents!);
  if (rows.length) {
    const lo = rows[0]!;
    const hi = rows[rows.length - 1]!;
    const n = f.quantity ?? 2;
    const basis = f.feeBasis === 'all_in' ? ` including fees${f.beforeTaxes ? ', before tax' : ''}` : '';
    return `${head}: ${rows.length} ticket option${rows.length === 1 ? '' : 's'} for ${qtyWord(n)}, from ${formatUsd(lo.perTicketCents!)} a ticket (${rowName(lo.label)})${hi !== lo ? ` to ${formatUsd(hi.perTicketCents!)} (${rowName(hi.label)})` : ''}${basis}: ${formatUsd(lo.perTicketCents! * n)}${hi !== lo ? ` to ${formatUsd(hi.perTicketCents! * n)}` : ''} for ${qtyWord(n)}.`;
  }
  const products = (f.products ?? []).filter((p) => !p.promoted);
  if (products.length) return `${head}: an artist page listing ${list(products.map((p) => `“${p.label}”${p.date ? ` (${dayLabel(p.date)})` : ''}`))}. It shows no prices.`;
  if (f.availability) return `${head}: the page said “${f.availability.text}”`;
  return `${head}.`;
}

export type EvidenceInput = {
  items: EvidenceItem[];
  latest: string;
  thread: string;
  quantity: number | null;
  budgetCents: number | null;
  /** True when the show the screenshot shows has already started (or ended), from the catalog. */
  started: boolean;
  /** Why we're answering here: facts that need no catalog, or a screenshot with no upcoming event to match. */
  mode: 'facts' | 'unmatched';
};

/**
 * The answer from their screenshots, or null when they asked nothing a screenshot can answer. Answers lead with the
 * decision; the times, admission, product terms and shown prices come from the image they belong to and no other.
 */
export function answerFromEvidence(x: EvidenceInput): EvidenceAnswer | null {
  if (!x.items.length) return null;
  const asks = evidenceAsks(x.latest);
  const coverage: Coverage[] = [];
  const parts: string[] = [];
  const latestItems = x.items.filter((i) => i.messageId === x.items[x.items.length - 1]!.messageId);
  // Two different shows: each explained from its own screenshot, never one request (A08).
  if (distinctActs(latestItems.map((i) => i.fields)) > 1 || distinctActs(x.items.map((i) => i.fields)) > 1 && asks.explain) {
    const seen = new Set<string>();
    const lines = latestItems.concat(x.items).map((i) => i.fields).filter((f) => {
      const k = [...actsOf(f)].sort().join('|');
      return seen.has(k) ? false : (seen.add(k), true);
    }).map(describe);
    coverage.push({ question: 'what each screenshot offers', status: 'answered' });
    if (/\b(?:choos|pick|decid|which (?:one|show))/i.test(x.latest)) coverage.push({ question: 'which show to shop', status: 'needs_clarification' });
    return {
      lead: 'These are two different shows, so I’ve kept them apart.',
      items: [...lines, 'Both are what the pages showed when you took the screenshots, not what’s on sale now. Tell me which show you pick and I’ll look at that one properly.'],
      coverage,
    };
  }
  // The newest screenshot with the facts asked about; earlier ones in the thread still count.
  const pick = (ok: (f: ListingFields) => boolean) => [...x.items].reverse().find((i) => ok(i.fields))?.fields ?? null;
  const n = x.quantity ?? pick((f) => !!f.quantity)?.quantity ?? 2;

  if (asks.times) {
    const f = pick((g) => !!(g.doorsTime || g.showTime || g.eventTime));
    if (f?.doorsTime && f.showTime) {
      parts.push(`Doors open at ${timeLabel(f.doorsTime)} and the show starts at ${timeLabel(f.showTime)}, going by the page in your screenshot.`);
      coverage.push({ question: 'doors or show time', status: 'answered' });
    } else if (f?.eventTime) {
      parts.push(`The page shows ${timeLabel(f.eventTime)}, but it doesn’t say whether that’s when doors open or when the show starts.`);
      coverage.push({ question: 'doors or show time', status: 'answered' });
    }
  }
  if (asks.admission) {
    const f = pick((g) => (g.offers ?? []).length > 0 || !!g.admission);
    if (f) {
      const want = areaIntent(`${x.thread}\n${x.latest}`).want ?? (/\bfloor\b/i.test(x.latest) ? 'floor' : null);
      const rows = (f.offers ?? []).filter((o) => !want || areaOf(o.label) === want);
      const kinds = new Set(rows.map((o) => o.admission));
      const label = want ? `The ${want} tickets` : 'These tickets';
      if (rows.length && kinds.size === 1 && kinds.has('standing')) parts.push(`${label} are standing room: general admission, with no assigned seats.`);
      else if (rows.length && kinds.size === 1 && kinds.has('seated')) parts.push(`${label} are assigned seats.`);
      else if (f.admission === 'standing') parts.push(`${label} are standing room, with no assigned seats.`);
      else parts.push(`The screenshot doesn’t say whether ${want ? `the ${want}` : 'these'} tickets are seated or standing.`);
      coverage.push({ question: 'seated or standing', status: 'answered' });
    }
  }
  const productPage = pick((g) => (g.products ?? []).length > 0);
  if (productPage && (asks.split || asks.product)) {
    const monthDay = askedMonthDay(x.latest) ?? askedMonthDay(x.thread);
    const single = singleFor(productPage, monthDay);
    const multi = (productPage.products ?? []).find((p) => !p.promoted && isMulti(p)) ?? null;
    if (asks.split && multi) {
      const term = splitTerm(multi);
      parts.push(`I wouldn’t count on it: the page lists it as “${multi.label}”${term && !multi.label.includes(term) ? `, with “${term}”` : ''}, so it’s one ticket for ${multi.endDate && multi.date ? `${dayLabel(multi.date)} to ${dayLabel(multi.endDate)}` : 'more than one night'}${term ? ' that can’t be split by day' : ''}, not two single-night tickets.`);
      parts.push('Whether someone else could use one of the nights depends on its terms, which the page doesn’t show.');
      if (single) parts.push(`For one night only, “${single.label}”${single.date ? ` on ${dayLabel(single.date)}` : ''} is the ticket to click.`);
      coverage.push({ question: 'using the other night of the multi-day ticket', status: 'answered' });
    } else if (asks.product || asks.split) {
      if (single) {
        parts.push(`Click “${single.label}”${single.date ? ` on ${dayLabel(single.date)}` : ''}${single.time ? ` at ${timeLabel(single.time)}` : ''}: that’s the normal concert ticket for that night.`);
        const sameDay = (productPage.products ?? []).filter((p) => p !== single && !p.promoted && (!single.date || p.date === single.date));
        for (const p of sameDay) {
          if (p.kind === 'suite') parts.push(`“${p.label}” is a suite booking${p.terms.some((t) => /partner/i.test(t)) ? ' on a partner site' : ''}, not a standard ticket.`);
          else if (isMulti(p)) parts.push(`“${p.label}” is one ticket for ${p.endDate && p.date ? `${dayLabel(p.date)} to ${dayLabel(p.endDate)}` : 'more than one night'}${splitTerm(p) ? ' and can’t be split by day' : ''}, so it isn’t a one-night ticket.`);
          else if (p.kind === 'package' || p.kind === 'add_on') parts.push(`“${p.label}” is ${p.kind === 'package' ? 'a package' : 'an add-on'}, not the concert ticket on its own.`);
        }
        const promoted = (productPage.products ?? []).concat().find((p) => p.promoted) ?? (productPage.events ?? []).find((e) => e.promoted);
        if (promoted) parts.push(`The promoted “${'label' in promoted ? promoted.label : promoted.name}” row is an ad for a different show.`);
        parts.push('The page shows no prices and doesn’t say whether seats are left, so it isn’t proof any are available.');
        coverage.push({ question: 'which product to choose', status: 'answered' });
      } else {
        coverage.push({ question: 'which product to choose', status: 'needs_clarification' });
      }
    }
  }
  if (asks.soldOut) {
    const f = pick((g) => !!g.availability || (g.notices ?? []).length > 0);
    if (f) {
      const name = f.eventName ?? (f.events ?? []).find((e) => !e.promoted)?.name ?? 'the show';
      const when = f.eventDate ? ` on ${dayLabel(f.eventDate)}` : '';
      const pkg = (f.notices ?? []).find((s) => /\b(?:package|hotel|bundle|vip)\b/i.test(s)) ?? null;
      if (f.availability?.status === 'sold_out') parts.push(`When you took the screenshot, the page for ${name}${when} said “${f.availability.text.replace(/[.\s]+$/, '')}.”`);
      if (pkg || /\bhotel|package\b/i.test(x.latest)) parts.push(`You don’t need a hotel package to get in: ${pkg ? 'the packages it advertises are' : 'a package is'} an optional bundle, not the only way to a ticket.`);
      if (f.availability?.status === 'sold_out') parts.push('For two normal tickets the other routes are resale, or more being released on the official page later. A screenshot can’t tell me what’s on sale now.');
      coverage.push({ question: 'sold out and hotel packages', status: 'answered' });
      if (/\bfind\b|\banother way\b/i.test(x.latest)) coverage.push({ question: 'find two normal tickets another way', status: 'operational_follow_up' });
    }
  }
  // Their price questions about the rows the screenshot showed: answered from those rows when there's no upcoming
  // event to price against (a show that has started), or when the rows are all they asked about.
  if (asks.prices && x.mode === 'unmatched') {
    const f = pick((g) => (g.offers ?? []).some((o) => o.perTicketCents !== null) || g.perTicketCents != null);
    if (f) {
      const chosenFields = chooseShownOffer(f, `${x.thread}\n${x.latest}`, null);
      const rows = (f.offers ?? []).filter((o) => o.perTicketCents !== null);
      const chosen = rows.find((o) => o.label === chosenFields.section && o.perTicketCents === chosenFields.perTicketCents) ?? null;
      const shown = shownPriceParts({ rows, chosen, quantity: n, budgetCents: x.budgetCents, text: x.latest, thread: x.thread, beforeTaxes: f.beforeTaxes ?? null });
      if (!shown.length && chosenFields.perTicketCents != null) {
        const basis = chosenFields.feeBasis === 'all_in' ? ` including fees${chosenFields.beforeTaxes ? ', before tax' : ''}` : '';
        shown.push(`${chosenFields.chosenFor ? `The ${chosenFields.chosenFor} option` : 'The cheapest option'} in your screenshot is “${rowName(chosenFields.section ?? '')}” at ${formatUsd(chosenFields.perTicketCents)} a ticket${basis}: ${formatUsd(chosenFields.perTicketCents * n)} for ${qtyWord(n)}.`);
      }
      parts.push(...shown);
      coverage.push({ question: 'the shown prices', status: shown.length ? 'answered' : 'needs_clarification' });
    }
  }
  if (!parts.length) return null;
  const tail = x.started ? 'That show has already started, so I can’t check what’s left now; this is what the page showed when you took the screenshot.' : null;
  if (x.started) coverage.push({ question: 'current tickets', status: 'unsupported' });
  return { lead: parts[0]!, items: [...parts.slice(1), ...(tail ? [tail] : [])], coverage };
}
