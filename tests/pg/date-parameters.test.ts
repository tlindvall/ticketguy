import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, lt, lte } from 'drizzle-orm';
import { openDatabase, type DbHandle } from '@/lib/db';
import { applyMigrations } from '@/lib/db/migrate';
import * as t from '@/lib/db/schema';

/**
 * Date parameters against real PostgreSQL. A JS Date interpolated into a raw sql`` template is handed to
 * the driver unconverted: PGlite tolerates it, postgres.js throws ERR_INVALID_ARG_TYPE. That difference
 * hid a 500 on /admin/operations and a silent failure in the watch cron until production. These queries
 * are the shapes those pages run, so a reintroduction fails here rather than on a deploy.
 */
const url = process.env.TEST_DATABASE_URL;
const describeIf = url ? describe : describe.skip;

describeIf('date parameters on real PostgreSQL', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openDatabase({ databaseUrl: url });
    await applyMigrations(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('compares a timestamp column against a Date (the /admin/operations stale-approvals count)', async () => {
    const now = new Date();
    const rows = await h.db
      .select({ id: t.recommendations.id })
      .from(t.recommendations)
      .where(and(eq(t.recommendations.reviewStatus, 'approved'), lt(t.recommendations.expiresAt, now)));
    expect(Array.isArray(rows)).toBe(true);
  });

  it('compares a timestamp column against a Date (the due-watches query)', async () => {
    const now = new Date();
    const rows = await h.db
      .select({ id: t.watches.id })
      .from(t.watches)
      .where(and(eq(t.watches.state, 'active'), lte(t.watches.nextCheckAt, now)));
    expect(Array.isArray(rows)).toBe(true);
  });
});
