/**
 * Does SeatData's listing_id equal the marketplace's own listing number? One paid listings read, in the Render shell:
 *   pnpm tsx scripts/probe-seatdata-link.ts "https://www.stubhub.com/.../event/161564036/?quantity=2&listingId=14251313815"
 * An event link with no listingId works too: it prints a few active StubHub rows, each with a StubHub link built from
 * its listing_id. Open one: if StubHub shows that listing with the same section, row and price, the ids are StubHub's.
 * A checkout link (checkout.stubhub.com/...?ID=<session>|<listingId>|<qty>|0) has no event id: pass the event link second.
 *
 * The link's StubHub event id is looked up directly (SDK 1.2: `listings/get?event_id_sh=`), so no catalog match is
 * involved. It prints structure and the one answer that decides DECISION_LOG #67: whether the link's listingId is
 * among the rows' listing_id values, and under which source. For a match it prints that row's section, row, price,
 * quantity and active flag, so a person can compare them with the StubHub page. Never the key, never other rows.
 */
import { SeatDataClient, SeatDataError } from '../src/lib/market/seatdata';
import { parseTicketLink } from '../src/lib/domain/ticket-links';

const key = process.env.SEATDATA_API_KEY;
if (!key) {
  console.error('[probe-link] SEATDATA_API_KEY is not set in this shell.');
  process.exit(1);
}
const first = process.argv[2] ? parseTicketLink(process.argv[2]) : null;
const second = process.argv[3] ? parseTicketLink(process.argv[3]) : null;
// A checkout link names the listing, the event link names the event: either order.
const link = first ? { ...first, eventId: first.eventId ?? second?.eventId ?? null, listingId: first.listingId ?? second?.listingId ?? null } : null;
if (!link || link.marketplace !== 'stubhub' || !link.eventId) {
  console.error('[probe-link] Pass a StubHub link with /event/<id>/ (an open listing adds listingId=<id>), or a checkout link followed by the event link.');
  process.exit(1);
}
const eventId = link.eventId;
const api = new SeatDataClient(key, { maxRetries: 0 });
const keys = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o as object).sort().join(', ') : String(o));
try {
  const r = await api.listingsByStubHubEvent(link.eventId);
  const rows = Array.isArray(r.listings) ? r.listings : [];
  const sources = new Map<string, number>();
  for (const x of rows) sources.set(String(x.source ?? x.marketplace ?? '(none)'), (sources.get(String(x.source ?? x.marketplace ?? '(none)')) ?? 0) + 1);
  const ids = rows.map((x) => x.listing_id ?? x.id).filter((v) => v !== undefined && v !== null);
  console.log(`[probe-link] StubHub event ${eventId}: ${rows.length} rows (has_refreshed ${r.has_refreshed ?? '—'}, last refresh ${r.last_refresh_timestamp ? new Date(Number(r.last_refresh_timestamp) * 1000).toISOString() : '—'})`);
  console.log(`  top-level keys: ${keys(r)}`);
  console.log(`  row keys: ${keys(rows[0])}`);
  console.log(`  rows by source: ${[...sources].map(([k, n]) => `${k} ${n}`).join(', ') || '—'}`);
  console.log(`  listing ids present: ${ids.length} of ${rows.length} · types: ${[...new Set(ids.map((v) => typeof v))].join(', ') || '—'} · sample lengths: ${[...new Set(ids.slice(0, 20).map((v) => String(v).length))].join(', ') || '—'} ${link.listingId ? `(the link's is ${link.listingId.length})` : ''}`);
  if (!link.listingId) {
    // No listing in the link: a few active StubHub rows, each as a StubHub link built from its id, to open and compare.
    const active = rows.filter((x) => (x.active === undefined || x.active === true || x.active === 1) && String(x.source ?? 'sh') === 'sh' && (x.listing_id ?? x.id) != null).slice(0, 5);
    if (!active.length) console.log('  No active StubHub rows to sample.');
    for (const x of active) {
      const id = String(x.listing_id ?? x.id);
      console.log(`  row: section ${x.section ?? '—'} · row ${x.row ?? '—'} · price ${x.price ?? '—'} · quantity ${x.quantity ?? '—'} · listing_id ${id}`);
      console.log(`       open: https://www.stubhub.com/event/${eventId}/?listingId=${encodeURIComponent(id)}`);
    }
    console.log('  → Open one link. If StubHub shows a listing in that section and row at about that price (StubHub may add fees), the ids are StubHub\'s own. If it opens nothing or a different listing, they are not.');
    process.exit(0);
  }
  const hit = rows.filter((x) => String(x.listing_id ?? x.id) === link.listingId);
  if (hit.length) {
    for (const x of hit) console.log(`  MATCH: source ${x.source ?? '—'} · section ${x.section ?? '—'} · row ${x.row ?? '—'} · price ${x.price ?? '—'} · quantity ${x.quantity ?? '—'} · active ${x.active ?? '—'}`);
    console.log('  → The ids are StubHub\'s own: compare the section, row and price above with the StubHub page to be sure.');
  } else {
    console.log(`  NO MATCH for listingId ${link.listingId}.${rows.length ? ' If the listing is still live on StubHub, SeatData\'s listing_id is not StubHub\'s number (or the row isn\'t stored yet).' : ' SeatData has no rows for this StubHub event id.'}`);
  }
} catch (e) {
  console.log(`[probe-link] FAILED ${e instanceof SeatDataError ? `${e.type} ${e.status ?? ''} ${e.message}` : e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
