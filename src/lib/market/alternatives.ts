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
  return { priceCents: Math.round(price * 100), quantity: qty, section: str(l.section), row: str(l.row), zone: str(l.zone), id, marketplace: src ? (MARKETPLACES[src] ?? null) : null };
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

export type Alternative = { scope: 'same_section' | 'same_zone'; listing: MarketListing; perTicketSavingCents: number };

export type AlternativesResult = {
  /** How many listings could seat the whole party. */
  comparable: number;
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
  const inSection = sec ? cheaper.find((l) => norm(l.section) === sec) : undefined;
  if (inSection) out.push({ scope: 'same_section', listing: inSection, perTicketSavingCents: subject.perTicketCents - inSection.priceCents });
  const inZone = zone ? cheaper.find((l) => l.zone === zone && norm(l.section) !== sec) : undefined;
  if (inZone) out.push({ scope: 'same_zone', listing: inZone, perTicketSavingCents: subject.perTicketCents - inZone.priceCents });
  return { comparable: fits.length, zone, alternatives: out, subjectPerTicketCents: subject.perTicketCents };
}
