import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { openTestDb, testEnv } from '../harness';
import { MarketTracker } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { SeatDataClient } from '@/lib/market/seatdata';

/**
 * PW-CALL-BUDGET-01, the part the retest left open ("Concurrent quota … a shared atomic reservation isn't built",
 * docs/qa/PRICE_WATCH_RETEST.md): a paid listings read takes its call from the day's allowance in the same statement
 * that checks the total, so two watches evaluated at once can't both spend the last call, and a read that finds
 * nothing left is recorded as skipped rather than silently absent. The boundaries the retest fixed (one call left,
 * room for retries, nothing left) are held here against the reservation too. The L01–L03 replays live in
 * price-watch-retest-live.test.ts.
 */
const NOW = new Date('2026-10-01T23:34:00Z');
const KEY = 'ab'.repeat(32);

describe('a paid read reserves its call before it is made', () => {
  let h: DbHandle;
  let reads = 0;
  let status = 503;
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/api/v0.1.1/listings/get') {
      reads += 1;
      return status === 200 ? new Response(JSON.stringify({ has_refreshed: true, listings: [] }), { status: 200 }) : new Response('{}', { status });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const tracker = (limit: number) => new MarketTracker({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY, SEATDATA_DAILY_CALL_LIMIT: String(limit) }), now: () => NOW, fetchImpl, sleep: async () => {} });
  const fetches = () => h.db.select().from(t.marketFetches).where(eq(t.marketFetches.kind, 'listings_watch'));
  const reset = async () => {
    reads = 0;
    status = 503;
    await h.db.delete(t.marketFetches);
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    await h.db.insert(t.trackedEvents).values({ eventId: FX.events.knicks, provider: 'seatdata', reasons: ['request'], nextPollAt: NOW, state: 'active', providerEventId: '555' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('the client stops at its cap, retries included, and the cap can be lifted again', async () => {
    reads = 0;
    const api = new SeatDataClient(KEY, { fetchImpl, sleep: async () => {} });
    // One attempt allowed: the 503 is made once, and the retry stops at the cap rather than spending a second call.
    api.callCap = 1;
    await expect(api.listings(555)).rejects.toMatchObject({ type: 'budget_exhausted' });
    expect(reads).toBe(1);
    await expect(api.listings(555)).rejects.toMatchObject({ type: 'budget_exhausted' });
    expect(reads).toBe(1);
    api.callCap = null;
    await expect(api.listings(555)).rejects.toMatchObject({ type: 'server_error' });
    expect(reads).toBe(4);
  });

  it('one call left: a 503 is attempted once, and the reserved row records that one call', async () => {
    await reset();
    expect(await tracker(1).listingsForWatch(FX.events.knicks, 4)).toBeNull();
    expect(reads).toBe(1);
    const rows = await fetches();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error', calls: 1 });
  });

  it('room for retries: three attempts at most, then only what is left', async () => {
    await reset();
    expect(await tracker(5).listingsForWatch(FX.events.knicks, 4)).toBeNull();
    expect(reads).toBe(3);
    expect((await fetches())[0]).toMatchObject({ status: 'error', calls: 3 });
    expect(await tracker(5).listingsForWatch(FX.events.knicks, 4)).toBeNull();
    expect(reads).toBe(5);
    expect((await fetches()).map((r) => r.calls).sort()).toEqual([2, 3]);
  });

  it('nothing left: no attempt, and the skipped read is on record', async () => {
    await reset();
    await tracker(1).listingsForWatch(FX.events.knicks, 4);
    expect(reads).toBe(1);
    expect(await tracker(1).listingsForWatch(FX.events.knicks, 4)).toBeNull();
    expect(reads).toBe(1);
    expect((await fetches()).map((r) => r.status).sort()).toEqual(['error', 'skipped_budget']);
  });

  it('two watches evaluated at once share the one call left', async () => {
    await reset();
    status = 200;
    const [a, b] = await Promise.all([tracker(1).listingsForWatch(FX.events.knicks, 4), tracker(1).listingsForWatch(FX.events.knicks, 4)]);
    expect(reads).toBe(1);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await fetches()).map((r) => r.status).sort()).toEqual(['skipped_budget', 'success']);
  });

  it('a successful read completes its reserved row rather than adding a second one', async () => {
    await reset();
    status = 200;
    expect(await tracker(3).listingsForWatch(FX.events.knicks, 4)).toMatchObject({ listings: 0, cheapestPerTicketCents: null });
    const rows = await fetches();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'success', calls: 1 });
    expect(await tracker(3).callsToday()).toBe(1);
  });
});
