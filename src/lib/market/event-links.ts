import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import * as t from '@/lib/db/schema';

/**
 * The marketplaces' own event pages for one of our games: StubHub's `/event/<id>/` and Vivid Seats' `/production/<id>`
 * (which redirects to the full page). A search link sent the customer to a results page for a game we had already
 * identified (Rangers vs Canadiens at MSG, Nov 16: StubHub 161415584, Vivid Seats 7301115). The ids are resolved once
 * per game and kept in `event_source_mappings` (sources `stubhub` and `vividseats`, role `marketplace`), from SeatData's
 * fields first, then the marketplace's own catalog where one is enabled. A search stays the fallback when neither
 * resolves. The pages are linked, never fetched (DECISION_LOG #47).
 */

export type Marketplace = 'stubhub' | 'vividseats';
export type MarketplaceIds = { stubhub: string | null; vividseats: string | null };
export const NO_MARKETPLACE_IDS: MarketplaceIds = { stubhub: null, vividseats: null };
const SOURCES: Marketplace[] = ['stubhub', 'vividseats'];

/** A marketplace event id is a plain number: anything else is not one we can build a page from. */
const ID = /^\d{4,15}$/;
const idOf = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  return ID.test(s) ? s : null;
};

export const stubhubEventUrl = (id: string, quantity: number) => `https://www.stubhub.com/event/${id}/?quantity=${Math.max(1, Math.floor(quantity))}`;
export const vividProductionUrl = (id: string) => `https://www.vividseats.com/production/${id}`;

/**
 * Search, campaign and location parameters the marketplaces add to a link (`qid`, `iid`, `ut`, `lat`, `lg`, `utm_*`):
 * they identify a session or a place, never the seats, so a link we send never carries them.
 */
const TRACKING = /^(?:qid|iid|ut|lat|lg|lon|lng|utm_\w+|gclid|fbclid|_gl)$/i;
export function withoutTracking(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/** The marketplace and event id a StubHub event link or a Vivid Seats production link names; null for anything else. */
export function marketplaceEventPage(url: string): { marketplace: Marketplace; id: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (/^(?:www\.)?stubhub\.com$/.test(u.hostname)) {
      const id = /\/event\/(\d{4,15})(?:\/|$)/.exec(u.pathname)?.[1];
      return id ? { marketplace: 'stubhub', id } : null;
    }
    if (/^(?:www\.)?vividseats\.com$/.test(u.hostname)) {
      const id = /\/production\/(\d{4,15})(?:\/|$)/.exec(u.pathname)?.[1];
      return id ? { marketplace: 'vividseats', id } : null;
    }
  } catch {
    // not a URL
  }
  return null;
}

/**
 * The marketplace event ids a SeatData reply carries: an event from its search, a listings reply, or its rows. None of
 * these fields is documented, so each is read defensively under the names SeatData uses elsewhere (`event_id_sh` is
 * the listings read's own parameter), and a listing's page link names its event too.
 */
export function idsFromSeatData(...objs: Array<Record<string, unknown> | null | undefined>): MarketplaceIds {
  const out: MarketplaceIds = { stubhub: null, vividseats: null };
  const urlKeys = ['url', 'listing_url', 'link', 'deep_link', 'event_url', 'sh_url', 'vs_url', 'stubhub_url', 'vividseats_url'];
  for (const o of objs) {
    if (!o) continue;
    out.stubhub ??= idOf(o.event_id_sh) ?? idOf(o.stubhub_event_id) ?? idOf(o.sh_event_id);
    out.vividseats ??= idOf(o.event_id_vs) ?? idOf(o.vividseats_event_id) ?? idOf(o.vivid_event_id) ?? idOf(o.vs_event_id) ?? idOf(o.vs_production_id) ?? idOf(o.production_id_vs);
    for (const k of urlKeys) {
      const v = o[k];
      const page = typeof v === 'string' ? marketplaceEventPage(v) : null;
      if (page) out[page.marketplace] ??= page.id;
    }
  }
  return out;
}

/** The ids already resolved for one of our events. */
export async function storedMarketplaceIds(db: DbOrTx, eventId: string): Promise<MarketplaceIds> {
  const rows = await db.select({ source: t.eventSourceMappings.sourceId, id: t.eventSourceMappings.sourceEventId }).from(t.eventSourceMappings).where(and(eq(t.eventSourceMappings.eventId, eventId), inArray(t.eventSourceMappings.sourceId, SOURCES), isNotNull(t.eventSourceMappings.sourceEventId)));
  const out: MarketplaceIds = { stubhub: null, vividseats: null };
  for (const r of rows) if (idOf(r.id)) out[r.source as Marketplace] ??= r.id;
  return out;
}

/**
 * Keep what was found. One id per marketplace per game, and one game per marketplace id (the mapping's unique key):
 * an id another event already holds is never moved, and a game that has one keeps it.
 */
export async function rememberMarketplaceIds(db: DbOrTx, eventId: string, ids: Partial<MarketplaceIds>, how: 'seatdata' | 'catalog', now: Date = new Date()): Promise<MarketplaceIds> {
  const have = await storedMarketplaceIds(db, eventId);
  for (const m of SOURCES) {
    const id = idOf(ids[m]);
    if (!id || have[m]) continue;
    const url = m === 'stubhub' ? `https://www.stubhub.com/event/${id}/` : vividProductionUrl(id);
    const [row] = await db.insert(t.eventSourceMappings).values({ eventId, sourceId: m, sourceEventId: id, authoritativeUrl: url, role: 'marketplace', confidence: how === 'catalog' ? 'verified' : 'provider', verifiedAt: now }).onConflictDoNothing().returning({ id: t.eventSourceMappings.id });
    if (row) have[m] = id;
  }
  return have;
}

/** A marketplace's own lookup of a game's event id by team, venue and date. Null when it isn't there or can't say. */
export type MarketplaceEventLookup = { marketplace: Marketplace; find: (q: { name: string; venue: string; city: string | null; localDate: string }) => Promise<string | null> };

/**
 * The game's marketplace ids, resolved once: stored ids, then what SeatData said, then each marketplace's own lookup
 * for one still missing. What's found is stored; a lookup that fails or finds nothing leaves the search fallback.
 */
export async function resolveMarketplaceIds(db: DbOrTx, a: { eventId: string; name: string; venue: string; city: string | null; localDate: string; seatData?: Partial<MarketplaceIds> | null; fromLink?: Partial<MarketplaceIds> | null; lookups?: MarketplaceEventLookup[]; now?: Date }): Promise<MarketplaceIds> {
  let ids = await storedMarketplaceIds(db, a.eventId);
  if (a.seatData && SOURCES.some((m) => !ids[m] && idOf(a.seatData![m]))) ids = await rememberMarketplaceIds(db, a.eventId, a.seatData, 'seatdata', a.now);
  for (const l of a.lookups ?? []) {
    if (ids[l.marketplace]) continue;
    const id = await l.find({ name: a.name, venue: a.venue, city: a.city, localDate: a.localDate }).catch(() => null);
    if (idOf(id)) ids = await rememberMarketplaceIds(db, a.eventId, { [l.marketplace]: id }, 'catalog', a.now);
  }
  // A link the customer sent names its event: used for this reply, never stored (it may be for another game).
  return { stubhub: ids.stubhub ?? idOf(a.fromLink?.stubhub), vividseats: ids.vividseats ?? idOf(a.fromLink?.vividseats) };
}

/**
 * Where to look on each marketplace: its event page when the id is known, its search for the game otherwise. The
 * search names the event as a fan types it ("Mind Enterprises (16 and over)" finds nothing; "Mind Enterprises" does).
 */
export function marketplaceLinks(ids: MarketplaceIds | null | undefined, a: { eventName: string; quantity: number; noun?: string; section?: string | null }): Record<Marketplace, { label: string; url: string; eventPage: boolean }> {
  const name = a.eventName.replace(/\s*\([^)]*\)/g, '').trim() || a.eventName;
  const q = encodeURIComponent(name);
  const what = a.section ? `section ${a.section}` : `this ${a.noun ?? 'event'}`;
  const sh = idOf(ids?.stubhub);
  const vs = idOf(ids?.vividseats);
  return {
    stubhub: sh ? { label: a.section ? `Find ${what} on StubHub` : 'Event page on StubHub', url: stubhubEventUrl(sh, a.quantity), eventPage: true } : { label: `Search StubHub for ${what}`, url: `https://www.stubhub.com/search?q=${q}`, eventPage: false },
    vividseats: vs ? { label: a.section ? `Find ${what} on Vivid Seats` : 'Event page on Vivid Seats', url: vividProductionUrl(vs), eventPage: true } : { label: `Search Vivid Seats for ${what}`, url: `https://www.vividseats.com/search?searchTerm=${q}`, eventPage: false },
  };
}
