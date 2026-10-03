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
  /**
   * The link's encoding was broken ("%ZZ" from a phone's copy): the parts that decoded are read as usual, the broken
   * ones are left as they were, and the reply can say the link came through damaged (LAUNCH-05).
   */
  malformed: boolean;
};

/**
 * decodeURIComponent, but one broken escape ("%ZZ", a lone "%") never throws: each run of valid escapes is decoded on
 * its own and anything that won't decode stays as typed. A link is the customer's input, not our bug, so it never
 * fails the whole email (live Oct 2, L03: a URIError retried four times, then went to a person).
 */
export function safeDecode(s: string): { text: string; malformed: boolean } {
  try {
    return { text: decodeURIComponent(s), malformed: false };
  } catch {
    const text = s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
    return { text, malformed: true };
  }
}

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

  const decoded = safeDecode(u.pathname);
  const path = decoded.text.toLowerCase();
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
  // A StubHub checkout link carries the listing and quantity in one ID: "<session>|<listingId>|<quantity>|<n>".
  const checkout = marketplace === 'stubhub' && /^checkout\./.test(host) ? /^[\w-]+\|(\d{6,20})\|(\d{1,2})\|/.exec(params.get('id') ?? '') : null;
  const quantity = qtyRaw && Number(qtyRaw) >= 1 && Number(qtyRaw) <= 20 ? Number(qtyRaw) : checkout && Number(checkout[2]) >= 1 && Number(checkout[2]) <= 20 ? Number(checkout[2]) : null;
  const listingId = LISTING_PARAMS.map((k) => params.get(k)).find((v) => v && /^[\w-]{3,40}$/.test(v)) ?? checkout?.[1] ?? null;
  const eventId = /\/(?:event|production|events)\/([\w-]{3,40})(?:\/|$)/.exec(path)?.[1] ?? null;

  // The first path segment carries the names: "new-york-rangers-new-york-tickets-10-1-2026".
  // A checkout, cart or account path names nothing ("/secure/buy/checkout" is not an event called "secure").
  const segs = path.split('/').filter(Boolean);
  const firstSeg = /^checkout\./.test(host) || /^(?:secure|checkout|cart|buy|order|orders|account|my|login|signin|purchase|payment)$/.test(segs[0] ?? '') ? '' : segs[0] ?? '';
  const slugText = firstSeg.replace(/-tickets?(?:-.*)?$/, '').replace(/-?\d{1,4}-\d{1,2}-\d{2,4}.*$/, '').replace(/[-_]+/g, ' ').trim() || null;

  return { url: raw, marketplace, localDate, quantity, listingId, eventId, slugText: slugText && /[a-z]{3}/.test(slugText) ? slugText : null, malformed: decoded.malformed };
}

/**
 * A show's own official ticket site, when the customer started there (LAUNCH-07, final launch QA L04: "This is where I
 * started: broadwaydirect.com/show/hamilton/" came back as "Event page on Ticketmaster"). Only sites that sell the shows
 * they list, and only a show page, never an account, cart or checkout page.
 */
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * A show page on the show's own seller, and only for this event: Broadway Direct's /show/<name>/ whose name is this
 * event's ("hamilton" for "Hamilton (NY)"). A lottery or terms page, another show, or any other path is not a reference.
 */
export function suppliedOfficialReference(urls: string[], eventName: string): { seller: string; url: string } | null {
  const name = norm(eventName);
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw.replace(/[.,;:!?)\]]+$/, ''));
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || !/^(?:www\.)?broadwaydirect\.com$/i.test(u.hostname)) continue;
    const show = /^\/show\/([a-z0-9-]+)\/?$/i.exec(u.pathname)?.[1];
    if (!show || !norm(show) || !` ${name} `.includes(` ${norm(show)} `)) continue;
    return { seller: 'Broadway Direct', url: `${u.origin}${u.pathname}` };
  }
  return null;
}

/** One line for the reply when a link came through damaged, so the customer knows what we did and didn't read from it. */
export function garbledLinkNote(urls: string[]): string | null {
  const broken = ticketLinksIn(urls).find((l) => l.malformed);
  return broken ? `Part of the ${MARKETPLACE_NAMES[broken.marketplace]} link you sent came through garbled, so I used the parts that came through and what you wrote.` : null;
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
