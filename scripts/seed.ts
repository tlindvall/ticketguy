/**
 * Controlled seed step (Render preDeployCommand). Mirrors scripts/migrate.ts: with a database URL it
 * connects directly and skips application-configuration validation, so seeding is never blocked by a
 * secret only the running app needs. Fixtures are seeded only in fixture mode (A13).
 */
import { openDatabase, openMigrationDatabase } from '../src/lib/db';
import { applyMigrations } from '../src/lib/db/migrate';
import { seedRegistry, seedFixtures } from '../src/lib/db/seed';
import { env } from '../src/lib/config/env';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const h = url ? await openMigrationDatabase(url) : await openDatabase();
const appMode = url ? (process.env.APP_MODE ?? 'live') : env().APP_MODE;
await applyMigrations(h);
const n = await seedRegistry(h.db);
console.log(`[seed] registry: ${n} sources imported as not_integrated (driver=${h.driver})`);
console.log('[seed] default kill switches ensured');
if (appMode === 'fixture') {
  await seedFixtures(h.db);
  console.log('[seed] fixture world seeded (synthetic venues/events/offers/history) — FIXTURE DATA ONLY');
} else {
  console.log(`[seed] APP_MODE=${appMode}: fixtures skipped`);
}
await h.close();
