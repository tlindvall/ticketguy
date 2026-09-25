import { loadRegistry } from '@/lib/sources/registry';

/**
 * Links a member of staff clicks to check a source by hand for one event. They are search pages, not
 * fetches: nothing here retrieves anything, and no result from following one is ever recorded without
 * the manual-observation form and its evidence fields. This is the "manual tasks for missing coverage"
 * the routing policy calls for (API_AND_DATA_CONTRACTS §2) until a source has an approved adapter.
 */
export type ResearchLink = { sourceId: string; name: string; url: string; kind: 'official_event_page' | 'search'; note: string | null };

/** Search-page shapes that are known to exist; anything else falls back to the source's home page with the query visible. */
const SEARCH_PATHS: Record<string, (q: string) => string> = {
  ticketmaster: (q) => `https://www.ticketmaster.com/search?q=${q}`,
  seatgeek: (q) => `https://seatgeek.com/search?search=${q}`,
  stubhub: (q) => `https://www.stubhub.com/search?q=${q}`,
  'vivid-seats': (q) => `https://www.vividseats.com/search?searchTerm=${q}`,
  tickpick: (q) => `https://www.tickpick.com/search?q=${q}`,
  gametime: (q) => `https://gametime.co/search?q=${q}`,
  'axs-us-axs-official-resale': (q) => `https://www.axs.com/search?q=${q}`,
  ticketnetwork: (q) => `https://www.ticketnetwork.com/search?q=${q}`,
  viagogo: (q) => `https://www.viagogo.com/search?q=${q}`,
};

export function researchLinksFor(args: { sourceIds: string[]; eventName: string; localDate: string | null; officialUrls: Record<string, string> }): ResearchLink[] {
  const reg = loadRegistry();
  const q = encodeURIComponent([args.eventName, args.localDate].filter(Boolean).join(' '));
  const out: ResearchLink[] = [];
  for (const id of args.sourceIds) {
    const src = reg.sources.find((s) => s.id === id);
    if (!src) continue;
    const official = args.officialUrls[id];
    if (official) {
      out.push({ sourceId: id, name: src.name, url: official, kind: 'official_event_page', note: 'Provider event page from discovery; the seller of record for this event.' });
      continue;
    }
    const build = SEARCH_PATHS[id];
    out.push({ sourceId: id, name: src.name, url: build ? build(q) : src.url, kind: 'search', note: build ? null : 'No search URL known for this source; opens the home page.' });
  }
  return out;
}
