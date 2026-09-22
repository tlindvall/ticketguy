import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import type { DbHandle } from './index';
import { schema } from './schema';

export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'drizzle');
const MIGRATION_LOCK_KEY = 7_248_113_901;

/**
 * Applies the committed /drizzle migration history. On PostgreSQL an advisory lock ensures
 * exactly one deploy step migrates at a time; PGlite is single-connection so no lock is needed.
 */
export async function applyMigrations(h: DbHandle): Promise<void> {
  if (h.driver === 'postgres') {
    const db = h.db as PostgresJsDatabase<typeof schema>;
    await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    try {
      await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    }
  } else {
    await migratePglite(h.db as PgliteDatabase<typeof schema>, { migrationsFolder: MIGRATIONS_FOLDER });
  }
}
