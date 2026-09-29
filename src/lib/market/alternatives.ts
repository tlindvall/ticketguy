/**
 * The market around one listing a customer showed us: cheaper listings for their party size in the same
 * section or the same part of the venue. Market listings are prices before fees with no link and no check
 * that they're still for sale; they point the customer at something worth looking for, never a verified offer.
 * A listing in the same section and row as theirs is left out: it may be the very same seats, and section and
 * row alone never prove that.
 */
export type MarketListing = { priceCents: number; quantity: number; section: string | null; row: string | null; zone: string | null };

export function toMarketListing(l: Record<string, unknown>): MarketListing | null {
  const active = l.active === undefined || l.active === null || l.active === true || l.active === 1 || l.active === 'true';
  const price = Number(l.price);
  const qty = Number(l.quantity);
  if (!active || !Number.isFinite(price) || price <= 0 || !Number.isInteger(qty) || qty <= 0) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { priceCents: Math.round(price * 100), quantity: qty, section: str(l.section), row: str(l.row), zone: str(l.zone) };
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
 * Listings clearly cheaper than the customer's, for at least their party size, in their section first and then
 * their part of the venue. "Clearly" allows for fees: when their price includes fees (or we can't tell), a
 * market price before fees counts only when it is cheaper even with fees of up to 30% on top.
 */
export function findAlternatives(listings: MarketListing[], subject: { perTicketCents: number; feeBasis: 'all_in' | 'before_fees' | 'unknown'; section: string | null; row: string | null }, quantity: number): AlternativesResult {
  const fits = listings.filter((l) => l.quantity >= quantity);
  const sec = norm(subject.section);
  const zone = sec ? (fits.find((l) => norm(l.section) === sec)?.zone ?? listings.find((l) => norm(l.section) === sec)?.zone ?? null) : null;
  const allowance = subject.feeBasis === 'before_fees' ? 0.95 : 1 / 1.3;
  const cap = Math.floor(subject.perTicketCents * allowance);
  const sameSeatsMaybe = (l: MarketListing) => !!sec && norm(l.section) === sec && !!subject.row && (l.row ?? '').toLowerCase() === subject.row.toLowerCase();
  const cheaper = fits.filter((l) => l.priceCents <= cap && !sameSeatsMaybe(l)).sort((a, b) => a.priceCents - b.priceCents);
  const out: Alternative[] = [];
  const inSection = sec ? cheaper.find((l) => norm(l.section) === sec) : undefined;
  if (inSection) out.push({ scope: 'same_section', listing: inSection, perTicketSavingCents: subject.perTicketCents - inSection.priceCents });
  const inZone = zone ? cheaper.find((l) => l.zone === zone && norm(l.section) !== sec) : undefined;
  if (inZone) out.push({ scope: 'same_zone', listing: inZone, perTicketSavingCents: subject.perTicketCents - inZone.priceCents });
  return { comparable: fits.length, zone, alternatives: out, subjectPerTicketCents: subject.perTicketCents };
}
