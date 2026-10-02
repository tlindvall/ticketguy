/**
 * Why a request found no performance (Final Human QA / deployed verification FV-R1-02, Hamilton's Sunday matinee).
 * Read-only, in the Render shell:
 *   pnpm tsx scripts/probe-discovery.ts "Hamilton" "New York" 2026-10-04
 * It prints, for that keyword, city and local date: what the catalog holds (name, local start, subtype, status,
 * venue), the recent catalog syncs and their recorded windows, then one live Ticketmaster Discovery call asked the
 * way the intake asks it (same geo point and radius, a page of 100, the whole day) and which of its events are in
 * the catalog. It upserts nothing and records no sync, so it can't make the app's next search look fresh. One
 * Discovery call against the daily limit. Never the key, never message text.
 */
import { and, desc, eq, gte, ilike, lte, or } from 'drizzle-orm';
import { openDatabase, openMigrationDatabase } from '../src/lib/db';
import * as t from '../src/lib/db/schema';
import { TicketmasterDiscoveryAdapter } from '../src/lib/sources/adapters';
import { geohash, marketFor } from '../src/lib/domain/markets';
import { normalizeKeyword } from '../src/lib/catalog/sync';

const [keyword, city, date] = process.argv.slice(2);
if (!keyword || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('[probe-discovery] Usage: pnpm tsx scripts/probe-discovery.ts "<performer or show>" "<city or empty>" YYYY-MM-DD');
  process.exit(1);
}
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const h = url ? await openMigrationDatabase(url) : await openDatabase();
const db = h.db;
const local = (d: Date, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
const day = (iso: string, delta: number) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + delta)).toISOString().slice(0, 10);

// The catalog, two days either side so a time-zone slip shows up as a near miss rather than nothing.
const from = new Date(`${day(date, -2)}T00:00:00Z`);
const to = new Date(`${day(date, 3)}T00:00:00Z`);
const like = `%${keyword}%`;
const rows = await db
  .select({ id: t.events.id, name: t.events.name, at: t.events.localStartAt, subtype: t.events.subtype, status: t.events.status, sale: t.events.saleStatus, venue: t.venues.name, vcity: t.venues.city, tz: t.venues.timezone, performer: t.entities.name })
  .from(t.events)
  .innerJoin(t.venues, eq(t.venues.id, t.events.venueId))
  .leftJoin(t.entities, eq(t.entities.id, t.events.primaryEntityId))
  .where(and(gte(t.events.localStartAt, from), lte(t.events.localStartAt, to), or(ilike(t.events.name, like), ilike(t.entities.name, like))))
  .orderBy(t.events.localStartAt);
console.log(`\n[probe-discovery] catalog: ${rows.length} event(s) matching "${keyword}" from ${day(date, -2)} to ${day(date, 2)}`);
for (const r of rows) console.log(`  ${local(r.at, r.tz)}  ${r.name}  · ${r.venue}, ${r.vcity ?? '—'}  · performer ${r.performer ?? '—'}  · subtype ${r.subtype ?? '—'}  · ${r.status}/${r.sale ?? '—'}`);

const syncs = await db.select().from(t.catalogSyncs).where(eq(t.catalogSyncs.keywordNormalized, normalizeKeyword(keyword))).orderBy(desc(t.catalogSyncs.syncedAt)).limit(10);
console.log(`\n[probe-discovery] last ${syncs.length} catalog sync(s) for "${normalizeKeyword(keyword)}":`);
for (const s of syncs) console.log(`  ${s.syncedAt.toISOString()}  ${s.status.padEnd(14)} ${String(s.eventCount).padStart(3)} events  window ${s.windowFrom ?? '—'} .. ${s.windowTo ?? '—'}  place ${s.city ?? 'national'}  (${s.trigger})`);

const audits = await db.select({ at: t.auditLog.createdAt, d: t.auditLog.diff }).from(t.auditLog).where(and(eq(t.auditLog.action, 'catalog.discovery_synced'), eq(t.auditLog.entityId, keyword.toLowerCase()))).orderBy(desc(t.auditLog.createdAt)).limit(5);
console.log(`\n[probe-discovery] last ${audits.length} intake discovery audit(s):`);
for (const a of audits) console.log(`  ${a.at.toISOString()}  ${JSON.stringify(a.d ?? {})}`);

const key = process.env.TICKETMASTER_DISCOVERY_API_KEY;
if (!key) {
  console.log('\n[probe-discovery] TICKETMASTER_DISCOVERY_API_KEY is not set in this shell: no live call.');
} else {
  // Asked as the intake asks: a named metro by its centre and radius, otherwise by city name.
  const mk = city ? marketFor(city, null) : null;
  const where = mk && mk.lat !== null && mk.lng !== null ? { geoPoint: geohash(mk.lat, mk.lng), radiusMiles: mk.radiusMiles, city: null } : { city: city || null };
  const q = { keyword, classificationName: null, stateCode: null, geoPoint: null, radiusMiles: null, ...where, startDateTime: `${date}T00:00:00Z`, endDateTime: `${day(date, 1)}T23:59:59Z`, size: 100 };
  console.log(`\n[probe-discovery] live Discovery: keyword "${keyword}", ${where.geoPoint ? `geo ${where.geoPoint} within ${where.radiusMiles} mi` : `city ${where.city ?? '(none)'}`}, ${q.startDateTime} .. ${q.endDateTime}, size 100`);
  const res = await new TicketmasterDiscoveryAdapter(key, true).discoverEvents(q);
  console.log(`  status ${res.status}, ${res.events.length} event(s)`);
  const known = new Set((await db.select({ id: t.eventSourceMappings.sourceEventId }).from(t.eventSourceMappings).where(eq(t.eventSourceMappings.sourceId, 'ticketmaster'))).map((m) => m.id));
  for (const e of res.events) console.log(`  ${e.localDate ?? '—'} ${e.localTime ?? '(no time)'}  ${e.name}  · ${e.venue?.name ?? '—'}, ${e.venue?.city ?? '—'}  · ${e.statusCode}  · id ${e.providerEventId}  · ${known.has(e.providerEventId) ? 'in catalog' : 'NOT in catalog'}`);
  if (res.status === 'success' && !res.events.length) console.log('  Discovery returned nothing for this keyword, place and day: the show is not in the connected source as asked.');
}
await h.close();
