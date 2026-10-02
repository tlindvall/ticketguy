/**
 * Why one request's reply had no listing or market (post-deploy QA Oct 2, PD-R1-01: the Rangers listing link).
 * Read-only, in the Render shell:
 *   pnpm tsx scripts/probe-request.ts <request id>          (the id on the admin request page)
 * Prints the request's event, party size and links (marketplace, event and listing ids only); its listing audits
 * (link matched, unmatched or skipped, with the gate); the event's SeatData tracking row; the last 48 hours of
 * SeatData reads for the event, each with its status and detail (success with a row count, error with the
 * provider's code, skipped with the reason, skipped_budget); and the licence and key state. No message text, no
 * keys, no signed URLs. It makes no provider call.
 */
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { openDatabase, openMigrationDatabase } from '../src/lib/db';
import * as t from '../src/lib/db/schema';
import { marketLicence } from '../src/lib/market/tracker';
import { SEATDATA_PROVIDER } from '../src/lib/market/series';
import { ticketLinksIn } from '../src/lib/domain/ticket-links';

const requestId = process.argv[2];
if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
  console.error('[probe-request] Usage: pnpm tsx scripts/probe-request.ts <request id>');
  process.exit(1);
}
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const h = url ? await openMigrationDatabase(url) : await openDatabase();
const db = h.db;

const [req] = await db.select().from(t.requests).where(eq(t.requests.id, requestId));
if (!req) {
  console.error(`[probe-request] No request ${requestId}.`);
  await h.close();
  process.exit(1);
}
const [version] = await db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId)).orderBy(desc(t.requestVersions.revision)).limit(1);
const brief = (version?.brief ?? {}) as { quantity?: number | null; submittedUrls?: string[] | null; performerOrTeam?: string | null };
const links = ticketLinksIn(brief.submittedUrls ?? []);
console.log(`\n[probe-request] request ${requestId}: state ${req.state}, revision ${req.currentRevision}, party ${brief.quantity ?? '—'}, performer ${brief.performerOrTeam ?? '—'}`);
for (const l of links) console.log(`  link: ${l.marketplace}, event id ${l.eventId ?? '—'}, listing id ${l.listingId ?? '—'}`);

if (req.eventId) {
  const [ev] = await db.select({ name: t.events.name, at: t.events.localStartAt }).from(t.events).where(eq(t.events.id, req.eventId));
  console.log(`  event: ${ev?.name ?? '—'} at ${ev?.at.toISOString() ?? '—'} (${req.eventId})`);
} else console.log('  event: none settled');

const audits = await db.select({ at: t.auditLog.createdAt, action: t.auditLog.action, diff: t.auditLog.diff }).from(t.auditLog).where(and(eq(t.auditLog.entityKind, 'request'), eq(t.auditLog.entityId, requestId))).orderBy(asc(t.auditLog.createdAt));
const shown = audits.filter((a) => /^(listing\.|market\.|catalog\.)/.test(a.action));
console.log(`\n[probe-request] listing and market audits (${shown.length} of ${audits.length}):`);
for (const a of shown) console.log(`  ${a.at.toISOString()}  ${a.action}  ${JSON.stringify(a.diff ?? {})}`);

if (req.eventId) {
  const tracked = await db.select().from(t.trackedEvents).where(and(eq(t.trackedEvents.eventId, req.eventId), eq(t.trackedEvents.provider, SEATDATA_PROVIDER)));
  console.log(`\n[probe-request] SeatData tracking: ${tracked.length ? '' : 'none (not matched through Ticketmaster; a StubHub link is read by its event id)'}`);
  for (const r of tracked) console.log(`  state ${r.state}, provider event ${r.providerEventId ?? '—'}, match attempts ${r.matchAttempts}, last polled ${r.lastPolledAt?.toISOString() ?? '—'}, last error ${r.lastError ?? '—'}`);
  const since = new Date(Date.now() - 48 * 3_600_000);
  const reads = await db.select().from(t.marketFetches).where(and(eq(t.marketFetches.eventId, req.eventId), gte(t.marketFetches.at, since))).orderBy(asc(t.marketFetches.at));
  console.log(`\n[probe-request] SeatData reads for this event, last 48h (${reads.length}):`);
  for (const r of reads) console.log(`  ${r.at.toISOString()}  ${r.kind.padEnd(16)} ${r.status.padEnd(14)} calls ${r.calls}  rows ${r.points}  ${r.detail ?? ''}`);
}

const lic = await marketLicence(db);
console.log(`\n[probe-request] SeatData licence: ${lic.status}, uses ${lic.uses.join(', ') || '(none)'}; key ${process.env.SEATDATA_API_KEY ? 'set' : 'NOT set'} in this shell`);
console.log('');
await h.close();
