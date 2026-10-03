import { parseTicketLink, safeDecode, type TicketLink } from './ticket-links';

/**
 * One outcome per URL a customer sent (final launch spec, Workstream B): what the link said, whether it identified the
 * event, what became of the listing it named and where we sent them. Built from what the request already recorded
 * (its brief, the listing-lookup audits, its tracked links), so a trace answers "what happened to this link" without a
 * production shell. Nothing here fetches a page; the URL is reported without its query string.
 */
export type LinkResolution = {
  /** Host and path only: query strings can carry cart or session ids. */
  url: string;
  host: string | null;
  parse: 'ok' | 'malformed' | 'unsupported_host' | 'not_a_url';
  link: Pick<TicketLink, 'marketplace' | 'localDate' | 'quantity' | 'listingId' | 'eventId'> | null;
  event: { status: 'resolved' | 'not_found'; eventId: string | null };
  listing: { status: 'matched' | 'unmatched' | 'skipped' | 'unavailable' | 'not_requested'; reason: string | null; providerAsOf: string | null; retrievedAt: string | null };
};

/** The listing-lookup audits a request wrote (listing.link_matched / link_unmatched / link_skipped), oldest first. */
export type LinkAudit = { action: string; diff: Record<string, unknown> | null };

export function resolveLinks(urls: string[], a: { eventId: string | null; audits: LinkAudit[] }): LinkResolution[] {
  return urls.map((raw) => {
    let u: URL | null = null;
    try {
      u = new URL(raw.replace(/[.,;:!?)\]]+$/, ''));
    } catch {
      u = null;
    }
    const url = u ? `${u.host}${safeDecode(u.pathname).text}` : raw.slice(0, 200);
    const link = u ? parseTicketLink(raw) : null;
    const parse: LinkResolution['parse'] = !u ? 'not_a_url' : !link ? 'unsupported_host' : link.malformed ? 'malformed' : 'ok';
    // Only the selected-listing lookup is audited, and only for StubHub and Vivid Seats links that name a listing.
    const looked = link?.listingId ? [...a.audits].reverse().find((x) => /^listing\.link_(matched|unmatched|skipped)$/.test(x.action) && (x.diff?.marketplace ?? link.marketplace) === link.marketplace) : undefined;
    const d = looked?.diff ?? {};
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const listing: LinkResolution['listing'] = !looked
      ? { status: 'not_requested', reason: link?.listingId ? 'no_lookup_for_this_marketplace_or_route' : null, providerAsOf: null, retrievedAt: null }
      : looked.action === 'listing.link_matched'
        ? { status: 'matched', reason: null, providerAsOf: str(d.providerAsOf), retrievedAt: str(d.retrievedAt) }
        : looked.action === 'listing.link_skipped'
          ? { status: 'skipped', reason: Array.isArray(d.gates) ? d.gates.join(',') : null, providerAsOf: null, retrievedAt: null }
          : d.read === false
            ? { status: 'unavailable', reason: 'listings_read_failed_or_not_allowed', providerAsOf: null, retrievedAt: null }
            : { status: 'unmatched', reason: 'listing_not_in_feed', providerAsOf: str(d.providerAsOf), retrievedAt: str(d.retrievedAt) };
    return {
      url,
      host: u?.host ?? null,
      parse,
      link: link ? { marketplace: link.marketplace, localDate: link.localDate, quantity: link.quantity, listingId: link.listingId, eventId: link.eventId } : null,
      event: { status: a.eventId ? 'resolved' : 'not_found', eventId: a.eventId },
      listing,
    };
  });
}
