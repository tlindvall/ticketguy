/**
 * The market around one listing a customer showed us: cheaper listings for their party size in the same
 * section or the same part of the venue. Market listings are prices before fees with no link and no check
 * that they're still for sale; they point the customer at something worth looking for, never a verified offer.
 * A listing in the same section and row as theirs is left out: it may be the very same seats, and section and
 * row alone never prove that.
 */
export type MarketListing = {
  priceCents: number;
  quantity: number;
  section: string | null;
  row: string | null;
  zone: string | null;
  /** The marketplace's own listing number, when the feed carries one. */
  id?: string | null;
  /** Which marketplace it is on, when the feed says (StubHub `sh`, Vivid Seats `vs`). */
  marketplace?: 'stubhub' | 'vividseats' | null;
  /** The listing's own page on StubHub or Vivid Seats, when the feed carries one (https, those hosts only). */
  url?: string | null;
  /** The feed's own note on the listing ("Limited view"), when it carries one: the only drawback we can read. */
  notes?: string | null;
};

const MARKETPLACES: Record<string, 'stubhub' | 'vividseats'> = { sh: 'stubhub', stubhub: 'stubhub', vs: 'vividseats', vivid: 'vividseats', vividseats: 'vividseats', vivid_seats: 'vividseats' };

export function toMarketListing(l: Record<string, unknown>): MarketListing | null {
  const active = l.active === undefined || l.active === null || l.active === true || l.active === 1 || l.active === 'true';
  const price = Number(l.price);
  const qty = Number(l.quantity);
  if (!active || !Number.isFinite(price) || price <= 0 || !Number.isInteger(qty) || qty <= 0) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // The item shape is undocumented: an id and a marketplace are read when present, under the names SeatData uses
  // elsewhere (sales carry `listing_id` and `source`).
  const rawId = l.listing_id ?? l.id;
  const id = typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : str(rawId);
  const src = str(l.source ?? l.marketplace ?? l.exchange)?.toLowerCase().replace(/[\s-]+/g, '_') ?? null;
  const url = listingUrl(l.url ?? l.listing_url ?? l.link ?? l.deep_link);
  const fromUrl = url ? (new URL(url).hostname.endsWith('stubhub.com') ? 'stubhub' : 'vividseats') : null;
  return { priceCents: Math.round(price * 100), quantity: qty, section: str(l.section), row: str(l.row), zone: str(l.zone), id, marketplace: (src ? (MARKETPLACES[src] ?? null) : null) ?? fromUrl, url, notes: str(l.notes) };
}

/**
 * Rows the feed marks no longer for sale (`active: false`), read with the same fields as live ones. They're never
 * priced or offered; they only let a linked listing that has gone be said as gone, not as "couldn't find it" (audit
 * 2026-10-10 gap 6).
 */
export function inactiveListings(raw: Array<Record<string, unknown>>): MarketListing[] {
  return raw.filter((l) => l.active === false || l.active === 0 || l.active === 'false').map((l) => toMarketListing({ ...l, active: true })).filter((l): l is MarketListing => l !== null);
}

/**
 * A drawback the feed itself states on a listing (Oct 10 framework, B7): a limited or obstructed view, or seats the note
 * says aren't together. Read from the listing's note only, never guessed from its price or section.
 */
export type ListingDrawback = 'obstructed_view' | 'seats_not_together';
export function listingDrawback(l: MarketListing): ListingDrawback | null {
  const n = l.notes ?? '';
  if (/\b(?:obstructed|limited|partial|restricted|side)[ -]view\b|\bview (?:is )?(?:obstructed|limited|restricted)\b|\bobstructed\b/i.test(n)) return 'obstructed_view';
  if (/\bnot (?:be )?(?:seated |sitting )?together\b|\bpiggy-?back\b/i.test(n)) return 'seats_not_together';
  return null;
}

/** A listing page we'd send a customer to: https on StubHub or Vivid Seats only, never any other host. */
function listingUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' && /^(?:www\.)?(?:stubhub\.com|vividseats\.com)$/.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The listing a customer linked, found in the resale feed by its own listing number. A match needs the same number
 * and, when the feed names the marketplace, the same marketplace; when it doesn't, the number has to be the only
 * one of its kind, so two marketplaces' numbers can't be confused. No match is no answer, never a near match: a
 * listing is never guessed from its section, row or price.
 */
export function matchLinkedListing(listings: MarketListing[], link: { marketplace: string; listingId: string | null }): MarketListing | null {
  if (!link.listingId || (link.marketplace !== 'stubhub' && link.marketplace !== 'vividseats')) return null;
  const same = listings.filter((l) => l.id === link.listingId);
  const named = same.filter((l) => l.marketplace === link.marketplace);
  if (named.length === 1) return named[0]!;
  const unnamed = same.filter((l) => !l.marketplace);
  return same.length === 1 && unnamed.length === 1 ? unnamed[0]! : null;
}

/** `drawback`: what the feed's note says is wrong with it; a clean listing in the same place is preferred over it. */
export type Alternative = { scope: 'same_section' | 'same_zone'; listing: MarketListing; perTicketSavingCents: number; drawback: ListingDrawback | null };

export type AlternativesResult = {
  /** How many listings could seat the whole party. */
  comparable: number;
  /** How many of those are in their section (theirs excluded): zero means nothing like for like was compared. */
  sectionListings?: number;
  zone: string | null;
  alternatives: Alternative[];
  /** The customer's price per ticket, as compared (before fees when that's what they gave). */
  subjectPerTicketCents: number;
};

const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/^(section|sec)\s*/, '').trim();

/**
 * Listings cheaper than the customer's, for at least their party size, in their section first and then their
 * part of the venue. No fee allowance is guessed: a market price before fees is compared as listed, and when
 * their price includes fees (or we can't tell) the claim says the two aren't on the same basis (remediation
 * review §4: no unvalidated percentage band drives ranking).
 */
export function findAlternatives(listings: MarketListing[], subject: { perTicketCents: number; feeBasis: 'all_in' | 'before_fees' | 'unknown'; section: string | null; row: string | null }, quantity: number): AlternativesResult {
  const fits = listings.filter((l) => l.quantity >= quantity);
  const sec = norm(subject.section);
  const zone = sec ? (fits.find((l) => norm(l.section) === sec)?.zone ?? listings.find((l) => norm(l.section) === sec)?.zone ?? null) : null;
  const cap = subject.perTicketCents - 1;
  const sameSeatsMaybe = (l: MarketListing) => !!sec && norm(l.section) === sec && !!subject.row && (l.row ?? '').toLowerCase() === subject.row.toLowerCase();
  const cheaper = fits.filter((l) => l.priceCents <= cap && !sameSeatsMaybe(l)).sort((a, b) => a.priceCents - b.priceCents);
  const out: Alternative[] = [];
  // The cheapest listing the feed doesn't fault first; one it does fault only when there is nothing clean there, so
  // "I'd choose this alternative" is never said of a limited view when an ordinary seat sits beside it (B6a vs B7).
  const pick = (xs: MarketListing[]) => xs.find((l) => !listingDrawback(l)) ?? xs[0];
  const inSection = sec ? pick(cheaper.filter((l) => norm(l.section) === sec)) : undefined;
  if (inSection) out.push({ scope: 'same_section', listing: inSection, perTicketSavingCents: subject.perTicketCents - inSection.priceCents, drawback: listingDrawback(inSection) });
  const inZone = zone ? pick(cheaper.filter((l) => l.zone === zone && norm(l.section) !== sec)) : undefined;
  if (inZone) out.push({ scope: 'same_zone', listing: inZone, perTicketSavingCents: subject.perTicketCents - inZone.priceCents, drawback: listingDrawback(inZone) });
  const sectionListings = sec ? fits.filter((l) => norm(l.section) === sec && !sameSeatsMaybe(l)).length : 0;
  return { comparable: fits.length, sectionListings, zone, alternatives: out, subjectPerTicketCents: subject.perTicketCents };
}

/**
 * Seats for the party when they sent nothing to judge (live Oct 3: "4 tickets to the next Rangers home game, max $400"
 * deserved seats, not questions). From the licensed listings read: the cheapest listings that can seat the whole party,
 * those that sell exactly their number or leave at least two first (a seller rarely leaves one ticket), and, with a
 * budget, only those whose estimated all-in total fits. Prices are listed before fees; the estimate adds the fee
 * allowance and says so. Not verified offers: no link, no check they're still there.
 */
export type ListingPick = { listing: MarketListing; listedTotalCents: number; estimatedTotalCents: number; exactSplit: boolean };
/**
 * range: the cheapest and dearest listed price a ticket, before fees, across every listing with enough tickets for them.
 * goal: what "best" meant to them; rankedBy: the order the picks are actually in ('view' only when the listings said
 * where their seats are). budgetFeeBasis 'before_fees': the budget was held against listed totals, not the estimate.
 */
export type ListingPicks = { picks: ListingPick[]; fits: boolean; budgetTotalCents: number | null; feeAllowancePct: number; comparable: number; cheaperUnsplit: ListingPick | null; range?: { lowCents: number; highCents: number; count: number }; goal?: 'view' | 'value' | 'price' | null; rankedBy?: 'view' | 'value' | 'price'; budgetFeeBasis?: 'all_in' | 'before_fees' | null };

/**
 * How close a listing's seats are, from the words the feed gives for its zone and section and its section number: 0 for
 * a named premium or lower area ("Courtside", "Club", "Lower Level", sections 100 to 199), 1 for the middle ("Mezzanine",
 * "Loge", the 200s), 2 for the top ("Upper", "Balcony", the 300s and up). Null when the feed says nothing we can place:
 * a view is never guessed from a price. "Floor" is left unplaced: standing room on a concert floor is close, not a view.
 */
export function viewTier(l: MarketListing): number | null {
  const words = `${l.zone ?? ''} ${l.section ?? ''}`.toLowerCase();
  if (/\b(?:upper|balcony|nosebleeds?|promenade|family circle|grandstand|bleachers|[3-5]00s?(?: level)?)\b/.test(words)) return 2;
  if (/\b(?:mezzanine|mezz|loge|middle|mid[- ]?level|dress circle|200s?(?: level)?)\b/.test(words)) return 1;
  if (/\b(?:courtside|rinkside|ice level|field level|club|premium|vip|orchestra|lower(?: level| bowl| tier)?|plaza|100s?(?: level)?)\b/.test(words)) return 0;
  const n = /^\s*(?:sec(?:tion)?\.?\s*)?(\d{3})\b/i.exec(l.section ?? '');
  if (!n) return null;
  const hundreds = Number(n[1]![0]);
  return hundreds === 1 ? 0 : hundreds === 2 ? 1 : hundreds >= 3 ? 2 : null;
}

/** A row as a number, nearest first: "3" is 3, "C" is 3, "AA" is 27. Null when the feed gives none we can read. */
function rowRank(row: string | null): number | null {
  const r = (row ?? '').trim().toUpperCase();
  if (/^\d{1,3}$/.test(r)) return Number(r);
  if (/^([A-Z])\1?$/.test(r)) return (r.length - 1) * 26 + (r.charCodeAt(0) - 64);
  return null;
}

export function pickListings(listings: MarketListing[], quantity: number, budgetTotalCents: number | null, feeAllowancePct: number, max = 3, opts: { goal?: 'view' | 'value' | 'price' | null; budgetFeeBasis?: 'all_in' | 'before_fees' | null } = {}): ListingPicks | null {
  const q = Math.max(1, Math.floor(quantity));
  const all = listings
    .filter((l) => l.quantity >= q)
    .map((l) => {
      const listedTotalCents = l.priceCents * q;
      return { listing: l, listedTotalCents, estimatedTotalCents: Math.round(listedTotalCents * (1 + feeAllowancePct / 100)), exactSplit: l.quantity === q || l.quantity - q >= 2 };
    })
    .sort((a, b) => Number(b.exactSplit) - Number(a.exactSplit) || a.listing.priceCents - b.listing.priceCents);
  if (!all.length) return null;
  // The range is of listings that sell as their number: a block that would leave the seller one seat isn't a price
  // they can buy at, and it is said separately as "why not cheaper".
  const sellable = all.some((p) => p.exactSplit) ? all.filter((p) => p.exactSplit) : all;
  const prices = sellable.map((p) => p.listing.priceCents);
  const range = { lowCents: Math.min(...prices), highCents: Math.max(...prices), count: sellable.length };
  // A budget they gave before fees is held against the listed total; all-in (or unsaid) against the fee estimate, which is
  // what checkout would come to (audit gap 10).
  const beforeFees = opts.budgetFeeBasis === 'before_fees';
  const within = budgetTotalCents === null ? all : all.filter((p) => (beforeFees ? p.listedTotalCents : p.estimatedTotalCents) <= budgetTotalCents);
  const byPrice = (xs: ListingPick[]) => [...xs].sort((a, b) => a.listing.priceCents - b.listing.priceCents || Number(b.exactSplit) - Number(a.exactSplit));
  // Distinct seats: the same section and row at the same price is one choice, however many listings carry it.
  const distinct = (xs: ListingPick[]) => [...new Map(xs.map((p) => [`${p.listing.section ?? ''}|${p.listing.row ?? ''}|${p.listing.priceCents}`, p])).values()];
  const goal = opts.goal ?? null;
  const told = { goal, budgetFeeBasis: opts.budgetFeeBasis ?? null };
  if (within.length) {
    const sellable = within.filter((p) => p.exactSplit).length ? within.filter((p) => p.exactSplit) : within;
    // "Cheapest is fine": the lowest price that seats them, a block that may leave the seller one ticket included (its
    // card says to check it sells as their number).
    if (goal === 'price') return { picks: distinct(byPrice(within)).slice(0, max), fits: true, budgetTotalCents, feeAllowancePct, comparable: all.length, cheaperUnsplit: null, range, rankedBy: 'price', ...told };
    // "Best view": the lowest tier, then the nearest row, then the price, within their budget; only when the listings
    // say where their seats are. Otherwise the picks are by price, and the email says so (never a better view from data
    // we don't have).
    if (goal === 'view' && sellable.some((p) => viewTier(p.listing) !== null)) {
      const rank = (p: ListingPick) => [viewTier(p.listing) ?? 9, rowRank(p.listing.row) ?? 999, p.listing.priceCents] as const;
      const byView = [...sellable].sort((a, b) => { const x = rank(a); const y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
      return { picks: distinct(byView).slice(0, max), fits: true, budgetTotalCents, feeAllowancePct, comparable: all.length, cheaperUnsplit: null, range, rankedBy: 'view', ...told };
    }
    const picks = distinct(byPrice(sellable)).slice(0, max);
    const cheaperUnsplit = byPrice(within).find((p) => !p.exactSplit && p.listing.priceCents < picks[0]!.listing.priceCents) ?? null;
    return { picks, fits: true, budgetTotalCents, feeAllowancePct, comparable: all.length, cheaperUnsplit, range, rankedBy: 'value', ...told };
  }
  return { picks: distinct(byPrice(all)).slice(0, 1), fits: false, budgetTotalCents, feeAllowancePct, comparable: all.length, cheaperUnsplit: null, range, rankedBy: 'value', ...told };
}
