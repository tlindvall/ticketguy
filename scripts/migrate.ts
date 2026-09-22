import { openDatabase } from '../src/lib/db';
import { applyMigrations } from '../src/lib/db/migrate';

// Controlled migration step. Uses MIGRATION_DATABASE_URL (privileged) when provided, else DATABASE_URL, else local PGlite.
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || undefined;
const h = await openDatabase(url ? { databaseUrl: url } : {});
console.log(`[migrate] driver=${h.driver}`);
await applyMigrations(h);
console.log('[migrate] done');
await h.close();
