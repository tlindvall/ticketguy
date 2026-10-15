import type { MarketplaceEventLookup } from './event-links';

/**
 * StubHub's own event lookup: its Catalog API (developer.stubhub.com, app-only OAuth, scope `read:events`), which
 * returns events with their page link and never other sellers' listings (PARTNER_ACCESS.md). Off unless
 * STUBHUB_CATALOG_ENABLED is set with the client credentials; nothing is enabled on a key alone.
 *
 * Not verified against a live payload: `scripts/probe-listing-api.ts stubhub` prints the shape and has to be run with
 * real credentials before this is switched on. Every field is read defensively: the id from the item or its
 * `event:webpage` link, the local date from the first ten characters of its start, the venue from the embedded venue.
 */
export function stubhubCatalogLookup(e: { clientId: string; clientSecret: string; sandbox?: boolean }, fetchImpl: typeof fetch = fetch): MarketplaceEventLookup {
  const host = e.sandbox ? 'sandbox.' : '';
  let token: { value: string; until: number } | null = null;
  const bearer = async (): Promise<string> => {
    if (token && token.until > Date.now()) return token.value;
    const basic = Buffer.from(`${encodeURIComponent(e.clientId)}:${encodeURIComponent(e.clientSecret)}`).toString('base64');
    const res = await fetchImpl(`https://${host}account.stubhub.com/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: 'grant_type=client_credentials&scope=read:events', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`stubhub token HTTP ${res.status}`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error('stubhub token missing');
    token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000 };
    return token.value;
  };
  return {
    marketplace: 'stubhub',
    async find(q) {
      const url = new URL(`https://${host}api.stubhub.net/catalog/events/search`);
      url.searchParams.set('q', q.name);
      url.searchParams.set('exclude_parking_passes', 'true');
      url.searchParams.set('page_size', '25');
      const res = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${await bearer()}`, accept: 'application/hal+json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { _embedded?: { items?: unknown[] } };
      const items = (body._embedded?.items ?? []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
      const norm = (s: unknown) => (typeof s === 'string' ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
      const sameDay = items.filter((x) => String(x.start_date ?? x.event_date ?? x.start_date_local ?? '').slice(0, 10) === q.localDate);
      const venueOf = (x: Record<string, unknown>) => ((x._embedded as { venue?: { name?: unknown } } | undefined)?.venue?.name ?? (x.venue as { name?: unknown } | undefined)?.name);
      // The venue decides between two games that day; a single game that day is that game only when no venue says otherwise.
      const hit = sameDay.find((x) => norm(venueOf(x)) === norm(q.venue)) ?? (sameDay.length === 1 && !venueOf(sameDay[0]!) ? sameDay[0] : undefined);
      if (!hit) return null;
      const href = ((hit._links as Record<string, { href?: unknown }> | undefined)?.['event:webpage']?.href ?? '') as string;
      const id = typeof hit.id === 'number' || typeof hit.id === 'string' ? String(hit.id) : (/\/event\/(\d+)/.exec(href)?.[1] ?? null);
      return id && /^\d{4,15}$/.test(id) ? id : null;
    },
  };
}
