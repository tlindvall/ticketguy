/**
 * Controlled migration step (Render preDeployCommand). With a database URL it connects directly and
 * skips application-configuration validation entirely — migrations must not be blocked by secrets that
 * only the running app needs. Without one it falls back to the local PGlite database.
 */
import { openDatabase, openMigrationDatabase } from '../src/lib/db';
import { applyMigrations } from '../src/lib/db/migrate';
import { syncTeamBrands } from '../src/lib/brand/sync-teams';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const h = url ? await openMigrationDatabase(url) : await openDatabase();
console.log(`[migrate] driver=${h.driver}${url ? ' (url supplied; app config not read)' : ' (local)'}`);
await applyMigrations(h);
// The team file (logos, colours, names) is data the app ships with: brought into the database on every deploy.
console.log(`[migrate] team brands: ${await syncTeamBrands(h.db)}`);
console.log('[migrate] done');
await h.close();
