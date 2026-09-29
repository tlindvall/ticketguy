/**
 * Resident Advisor (ra.co) is where club nights, DJ sets and underground electronic shows are listed; the
 * official listings we read (Ticketmaster) carry only a sliver of them. RA has no public API and we read
 * nothing from it: electronic-music replies link to RA's events page for the customer's city, so they can see
 * what's on there. It is a plain link, not an offer or an affiliate link.
 *
 * Only cities whose RA page has been opened and checked are listed; a wrong link in a customer email is worse
 * than none. Add a market here after checking its page in a browser.
 */
export const RA_EVENT_PAGES: Readonly<Record<string, { url: string; label: string }>> = {
  'new-york': { url: 'https://ra.co/events/us/newyork', label: 'New York on Resident Advisor' },
};

export type RaPointer = { lead: string; label: string; url: string };

export function raPointer(marketId: string | null | undefined, lead?: string): RaPointer | null {
  const page = marketId ? RA_EVENT_PAGES[marketId] : undefined;
  if (!page) return null;
  return { lead: lead ?? 'For club nights and DJ sets, Resident Advisor is the go-to, with far more listed than I can see.', label: page.label, url: page.url };
}
