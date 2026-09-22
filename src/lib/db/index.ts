import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import postgres from 'postgres';
import { env, ConfigurationError } from '@/lib/config/env';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { schema } from './schema';

/** Driver-neutral database type: both postgres.js and PGlite databases extend PgDatabase. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
/** Transaction handle shared across drivers; business code never sees driver-specific types. */
export type Tx = PgTransaction<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
export type DbOrTx = Db | Tx;

export type DbHandle = {
  db: Db;
  driver: 'postgres' | 'pglite';
  close: () => Promise<void>;
};

/**
 * Driver selection:
 *  - DATABASE_URL set → postgres.js pool (PG_POOL_MAX per process).
 *  - Otherwise, development/test only → PGlite persisted in PGLITE_DATA_DIR (or in-memory when dataDir is undefined/':memory:').
 * Production/staging never reach the PGlite branch: env() throws first.
 */
export async function openDatabase(opts: { databaseUrl?: string; pgliteDataDir?: string | null } = {}): Promise<DbHandle> {
  const e = env();
  const url = opts.databaseUrl ?? e.DATABASE_URL;
  if (url) {
    const client = postgres(url, { max: e.PG_POOL_MAX, idle_timeout: 20, connect_timeout: 10, prepare: false });
    const db = drizzlePg(client, { schema }) as unknown as Db;
    return { db, driver: 'postgres', close: () => client.end({ timeout: 5 }) };
  }
  if (e.isProductionLike) {
    throw new ConfigurationError('Refusing embedded database in a production-like environment');
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dataDir = opts.pgliteDataDir === undefined ? e.PGLITE_DATA_DIR : opts.pgliteDataDir;
  if (dataDir && dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    // PGlite is single-process. A stale postmaster.pid left by a killed dev server aborts the next open;
    // local development only ever runs one process against the data dir, so clear it.
    const stalePid = path.join(dataDir, 'postmaster.pid');
    if (existsSync(stalePid)) rmSync(stalePid, { force: true });
  }
  const client = dataDir && dataDir !== ':memory:' ? new PGlite(dataDir) : new PGlite();
  await client.waitReady;
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return { db, driver: 'pglite', close: () => client.close() };
}

/**
 * Opens a connection for the migration step alone. Deliberately does NOT read the application
 * configuration: a deploy's pre-deploy step must depend on the database URL and nothing else, so a
 * missing auth secret, model key or public URL — none of which a migration uses — cannot fail the deploy.
 */
export async function openMigrationDatabase(databaseUrl: string): Promise<DbHandle> {
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigurationError('Migration database URL must be a postgres:// URL');
  }
  const client = postgres(databaseUrl, { max: 1, idle_timeout: 20, connect_timeout: 15, prepare: false });
  const db = drizzlePg(client, { schema }) as unknown as Db;
  return { db, driver: 'postgres', close: () => client.end({ timeout: 5 }) };
}

/**
 * Process-wide handle (one pool per process). Stored on globalThis so Next.js dev's per-route module
 * instances and HMR reloads share one connection: PGlite refuses a second open of the same data dir,
 * and postgres.js pools must not multiply per compilation scope.
 */
const g = globalThis as unknown as { __tgDbHandle?: Promise<DbHandle> };
export function getDb(): Promise<DbHandle> {
  if (!g.__tgDbHandle) g.__tgDbHandle = openDatabase();
  return g.__tgDbHandle;
}

export async function closeDb(): Promise<void> {
  if (g.__tgDbHandle) {
    const h = await g.__tgDbHandle;
    g.__tgDbHandle = undefined;
    await h.close();
  }
}
