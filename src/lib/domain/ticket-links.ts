/**
 * What a ticket-site link says about the request: the event's date, how many tickets and which listing. A
 * customer who pastes a StubHub link has told us the game and the party size as surely as if they had typed
 * them, so the link is read the same way as their words. Only the URL itself is read; the page is never
 * fetched (listings sit behind the marketplace's own access controls).
 */
export type TicketLink = {
  url: string;
  marketplace: 'stubhub' | 'ticketmaster' | 'seatgeek' | 'vividseats' | 'gametime' | 'tickpick' | 'axs';
  /** The event's local date from the path (YYYY-MM-DD), when the marketplace puts one there. */
  localDate: string | null;
  quantity: number | null;
  listingId: string | null;
  eventId: string | null;
  /** The words of the path before the date: "new york rangers new york". */
  slugText: string | null;
};

const HOSTS: Array<[RegExp, TicketLink['marketplace']]> = [
  [/(^|\.)stubhub\.[a-z.]+$/, 'stubhub'],
  [/(^|\.)ticketmaster\.[a-z.]+$/, 'ticketmaster'],
  [/(^|\.)livenation\.com$/, 'ticketmaster'],
  [/(^|\.)seatgeek\.com$/, 'seatgeek'],
  [/(^|\.)vividseats\.com$/, 'vividseats'],
  [/(^|\.)gametime\.co$/, 'gametime'],
  [/(^|\.)tickpick\.com$/, 'tickpick'],
  [/(^|\.)axs\.com$/, 'axs'],
];

const QTY_PARAMS = ['quantity', 'qty', 'tickets', 'ticketqty', 'ticketquantity', 'quantity_selected'];
const LISTING_PARAMS = ['listingid', 'listing_id', 'listing', 'ticket_id', 'ticketid'];

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // Feb 30 is not a date
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseTicketLink(raw: string): TicketLink | null {
  let u: URL;
  try {
    u = new URL(raw.replace(/[.,;:!?)\]]+$/, ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const marketplace = HOSTS.find(([re]) => re.test(host))?.[1];
  if (!marketplace) return null;

  const path = decodeURIComponent(u.pathname).toLowerCase();
  // US order in slugs (StubHub, Ticketmaster, Vivid Seats): 10-1-2026 or 10-01-2026; ISO (SeatGeek): 2026-10-01.
  let localDate: string | null = null;
  const us = /(?:^|[-/])(\d{1,2})-(\d{1,2})-(20\d{2})(?=$|[-/])/.exec(path);
  const isoM = /(?:^|[-/])(20\d{2})-(\d{2})-(\d{2})(?=$|[-/])/.exec(path);
  if (us) {
    localDate = iso(Number(us[3]), Number(us[1]), Number(us[2]));
  } else if (isoM) {
    localDate = iso(Number(isoM[1]), Number(isoM[2]), Number(isoM[3]));
  }

  const params = new Map<string, string>();
  for (const [k, v] of u.searchParams) params.set(k.toLowerCase(), v);
  const qtyRaw = QTY_PARAMS.map((k) => params.get(k)).find((v) => v && /^\d{1,2}$/.test(v));
  const quantity = qtyRaw && Number(qtyRaw) >= 1 && Number(qtyRaw) <= 20 ? Number(qtyRaw) : null;
  const listingId = LISTING_PARAMS.map((k) => params.get(k)).find((v) => v && /^[\w-]{3,40}$/.test(v)) ?? null;
  const eventId = /\/(?:event|production|events)\/([\w-]{3,40})(?:\/|$)/.exec(path)?.[1] ?? null;

  // The first path segment carries the names: "new-york-rangers-new-york-tickets-10-1-2026".
  const firstSeg = path.split('/').filter(Boolean)[0] ?? '';
  const slugText = firstSeg.replace(/-tickets?(?:-.*)?$/, '').replace(/-?\d{1,4}-\d{1,2}-\d{2,4}.*$/, '').replace(/[-_]+/g, ' ').trim() || null;

  return { url: raw, marketplace, localDate, quantity, listingId, eventId, slugText: slugText && /[a-z]{3}/.test(slugText) ? slugText : null };
}

export function ticketLinksIn(urls: string[]): TicketLink[] {
  return urls.map(parseTicketLink).filter((l): l is TicketLink => l !== null);
}

export const MARKETPLACE_NAMES: Record<TicketLink['marketplace'], string> = {
  stubhub: 'StubHub',
  ticketmaster: 'Ticketmaster',
  seatgeek: 'SeatGeek',
  vividseats: 'Vivid Seats',
  gametime: 'Gametime',
  tickpick: 'TickPick',
  axs: 'AXS',
};
