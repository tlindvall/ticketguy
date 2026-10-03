import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, testEnv } from '../harness';
import { FIXTURE_NOW, FX } from '@/lib/fixtures';
import { MarketTracker } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID, listingAge } from '@/lib/market/series';

/**
 * LAUNCH-06 (final launch spec, Workstream D): current listings carry two clocks. `providerAsOf` is when SeatData last
 * refreshed them (null when it didn't say), `retrievedAt` when we fetched. Fetching a cached response again never makes
 * it newer: not its age, not a watch's freshness, not when a listing number was last seen.
 */
const H = 3_600_000;
const KEY = 'ab'.repeat(32);

describe('LAUNCH-06: the provider clock on current listings', () => {
  let h: DbHandle;
  let now = FIXTURE_NOW;
  let refreshed: Date | null = null;
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/api/v0.1.1/listings/get') return new Response(JSON.stringify({ has_refreshed: 0, ...(refreshed ? { last_refresh_timestamp: Math.floor(refreshed.getTime() / 1000) } : {}), listings: [{ active: true, listing_id: 9001, source: 'sh', price: 120, quantity: 2, section: '101', row: 'A' }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const tracker = () => new MarketTracker({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY }), now: () => now, fetchImpl, sleep: async () => {} });
  const read = () => tracker().currentListings(FX.events.knicks, 'listings_compare', '161000999');
  const lastSeen = async () => (await h.db.select().from(t.marketListingSightings).where(and(eq(t.marketListingSightings.listingId, '9001'), eq(t.marketListingSightings.eventId, FX.events.knicks))))[0]?.lastSeenAt ?? null;

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });
  afterAll(async () => {
    await h.close();
  });

  it('a read returns the provider time and the fetch time apart; an undated read has no provider time', async () => {
    refreshed = new Date(now.getTime() - 5 * H);
    expect(await read()).toMatchObject({ providerAsOf: refreshed, retrievedAt: now });
    refreshed = null;
    expect(await read()).toMatchObject({ providerAsOf: null, retrievedAt: now });
    const [log] = await h.db.select().from(t.marketFetches).where(eq(t.marketFetches.kind, 'listings_compare')).limit(1);
    expect(log!.detail).toMatch(/provider as of 2026-09-22T10:00:00\.000Z/);
  });

  it('a listing number is "last seen" when the provider last refreshed it; a cached or undated re-read never moves that forward', async () => {
    await h.db.delete(t.marketListingSightings);
    const t0 = new Date(now.getTime() - 6 * H);
    refreshed = t0;
    await read();
    expect(await lastSeen()).toEqual(t0);
    // The same cached response, fetched two hours later: still last seen at the provider's refresh.
    now = new Date(FIXTURE_NOW.getTime() + 2 * H);
    await read();
    expect(await lastSeen()).toEqual(t0);
    // An undated read can't vouch for the listing either.
    refreshed = null;
    await read();
    expect(await lastSeen()).toEqual(t0);
    // A real refresh moves it forward; an older refresh arriving later never moves it back.
    const t1 = new Date(now.getTime() - 30 * 60_000);
    refreshed = t1;
    await read();
    expect(await lastSeen()).toEqual(t1);
    refreshed = t0;
    await read();
    expect(await lastSeen()).toEqual(t1);
    now = FIXTURE_NOW;
  });

  it('age by the provider clock: undated, recent under two hours, else whole hours', () => {
    expect(listingAge(null, FIXTURE_NOW)).toBe('undated');
    expect(listingAge(new Date(FIXTURE_NOW.getTime() - 90 * 60_000), FIXTURE_NOW)).toBe('recent');
    expect(listingAge(new Date(FIXTURE_NOW.getTime() - 5 * H), FIXTURE_NOW)).toBe(5);
  });
});
