/**
 * Release checks that need real PostgreSQL (final launch spec A19, A26 migration part). PGlite runs the unit and
 * acceptance suites; it is one process, so it can't show what concurrent writers or leases do on the real database.
 *
 * ISOLATED DATABASE ONLY. It migrates, seeds fixture rows and writes test data. It refuses to run:
 *   - without PG_ACCEPTANCE_URL (it never reads DATABASE_URL or MIGRATION_DATABASE_URL);
 *   - when that URL equals DATABASE_URL or MIGRATION_DATABASE_URL;
 *   - when the database name doesn't contain "test", "acceptance" or "scratch";
 *   - when the database already has requests in it.
 *
 *   PG_ACCEPTANCE_URL=postgres://user:pass@host:5432/ticketguy_acceptance pnpm tsx scripts/pg-acceptance.ts
 *
 * Prints one JSON report (no credentials) and exits 1 when any check fails. Drop the database afterwards.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { openDatabase } from '../src/lib/db';
import { applyMigrations } from '../src/lib/db/migrate';
import { seedFixtures, seedRegistry } from '../src/lib/db/seed';
import * as t from '../src/lib/db/schema';
import { FX } from '../src/lib/fixtures';
import { leaseDueOutbox } from '../src/lib/intake/outbox';
import { storeSeriesPoints } from '../src/lib/market/tracker';
import { marketBasketKey, pointsFromListings } from '../src/lib/market/series';

const url = process.env.PG_ACCEPTANCE_URL;
const refuse = (why: string) => {
  console.error(`[pg-acceptance] Refusing to run: ${why}`);
  process.exit(2);
};
if (!url) refuse('set PG_ACCEPTANCE_URL to an isolated, disposable PostgreSQL database.');
if (url === process.env.DATABASE_URL || url === process.env.MIGRATION_DATABASE_URL) refuse('PG_ACCEPTANCE_URL is the application database.');
let dbName = '';
try {
  dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
} catch {
  refuse('PG_ACCEPTANCE_URL is not a URL.');
}
if (!/test|acceptance|scratch/i.test(dbName)) refuse(`database "${dbName}" isn't named as a test database (needs "test", "acceptance" or "scratch").`);

const h = await openDatabase({ databaseUrl: url });
if (h.driver !== 'postgres') refuse('not a PostgreSQL connection.');
const db = h.db;
const checks: Array<{ id: string; ok: boolean; detail: unknown }> = [];
const check = (id: string, ok: boolean, detail: unknown) => checks.push({ id, ok, detail });

try {
  const existing = await db.execute(sql`select to_regclass('public.requests') is not null as has`);
  const has = (existing as unknown as Array<{ has: boolean }>)[0]?.has;
  if (has) {
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(t.requests);
    if ((n?.n ?? 0) > 0) refuse('the database already holds requests; use an empty one.');
  }

  // A26 (migration part): every checked-in migration applies, and 0021's column and the observation index exist.
  await applyMigrations(h);
  await seedRegistry(db);
  await seedFixtures(db);
  const cols = (await db.execute(sql`select column_name from information_schema.columns where table_name = 'market_snapshots' and column_name in ('provider_as_of', 'retrieved_at')`)) as unknown as Array<{ column_name: string }>;
  check('A26-migration-0021-columns', cols.length === 2, cols.map((c) => c.column_name).sort());
  const idx = (await db.execute(sql`select indexname from pg_indexes where tablename = 'market_snapshots' and indexname = 'market_snapshots_event_basket_time_uq'`)) as unknown as Array<{ indexname: string }>;
  check('A26-observation-unique-index', idx.length === 1, idx.map((i) => i.indexname));

  // A19: one provider observation is one row, however many times and however concurrently it is stored; the same
  // price at a new provider time is a new row.
  const ev = { id: FX.events.knicks, localStartAt: new Date(Date.now() + 30 * 86_400_000) };
  const listings = [{ active: true, price: 120, quantity: 6, zone: 'Upper' }];
  const t0 = new Date(Date.now() - 5 * 3_600_000);
  const key = marketBasketKey(ev.id, 'group:4', null);
  const rows = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(t.marketSnapshots).where(and(eq(t.marketSnapshots.eventId, ev.id), eq(t.marketSnapshots.basketKey, key))))[0]!.n;
  await Promise.all(Array.from({ length: 8 }, (_, i) => storeSeriesPoints(db, ev, pointsFromListings(listings, [4], new Date(Date.now() + i * 1000), t0))));
  check('A19-same-provider-time-concurrent', (await rows()) === 1, { rows: await rows(), writers: 8 });
  await storeSeriesPoints(db, ev, pointsFromListings(listings, [4], new Date(Date.now() + 3_600_000), t0));
  check('A19-same-provider-time-later-fetch', (await rows()) === 1, { rows: await rows() });
  await storeSeriesPoints(db, ev, pointsFromListings(listings, [4], new Date(), new Date(t0.getTime() + 8 * 3_600_000)));
  check('A19-unchanged-price-new-provider-time', (await rows()) === 2, { rows: await rows() });

  // A26 (queue part): concurrent lease claims never hand the same job to two workers.
  const now = new Date();
  const ids = Array.from({ length: 40 }, () => randomUUID());
  await db.insert(t.outboxEvents).values(ids.map((id, i) => ({ eventType: 'retention.due', eventKey: `pg-acceptance-${id}`, entityId: id, payload: { n: i }, nextAttemptAt: now })));
  const leased = (await Promise.all(Array.from({ length: 6 }, () => leaseDueOutbox(db, { limit: 10, now: new Date(now.getTime() + 1000) })))).flat().filter((e) => e.eventKey.startsWith('pg-acceptance-'));
  const unique = new Set(leased.map((e) => e.id));
  check('A26-concurrent-leases-disjoint', unique.size === leased.length && leased.length === ids.length, { leased: leased.length, unique: unique.size, jobs: ids.length });
} finally {
  await h.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ database: dbName, checks, passed: checks.length - failed.length, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
