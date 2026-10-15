import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, RecordingProvider, testEnv } from '../harness';
import { MarketTracker } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID, SEATDATA_PROVIDER } from '@/lib/market/series';
import { alertMarketGaps, likelyCause, marketGaps, trackingDiagnosis } from '@/lib/market/staleness';
import { audit } from '@/lib/util/audit';

/**
 * Oct 11-14: SeatData billed no requests at all while Rangers requests stayed open with games coming up, and nothing
 * said so. A game a customer asked about with no SeatData check in 36 hours now raises one staff email a day, with
 * the likely cause; every hourly pass is recorded, blocked or not, so a dead scheduler and a blocked pass look
 * different; an account refusal that stops a pass is on the pass record.
 */
const H = 3_600_000;
const KEY = 'cd'.repeat(32);
const ARENA = '10000000-0000-4000-8000-00000000a015';
const TEAM = '20000000-0000-4000-8000-00000000a015';
const OLD_ASK = '30000000-0000-4000-8000-00000000a015';
const NEW_ASK = '30000000-0000-4000-8000-00000000b015';

describe('a requested game with no SeatData check in 36 hours', () => {
  let h: DbHandle;
  const now = new Date('2026-10-14T15:00:00Z');
  const env = testEnv({ SEATDATA_API_KEY: KEY, STAFF_ALERT_ADDRESSES: 'ops@ticketguy.example' });

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Gap Garden', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Gap Rangers', slug: 'gap-rangers', aliases: [], league: 'NHL', homeVenueId: ARENA });
    const game = (id: string, start: string, name: string) => ({ id, name, category: 'nhl', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date(start), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: false, saleStatus: 'onsale' });
    await h.db.insert(t.events).values([game(OLD_ASK, '2026-11-16T23:00:00Z', 'Gap Rangers vs. Canadiens'), game(NEW_ASK, '2026-11-20T00:00:00Z', 'Gap Rangers vs. Bruins')]);
    const [contact] = await h.db.insert(t.contacts).values({ emailOriginal: 'gap@customer.example', emailLookup: 'gap@customer.example' }).returning();
    const [conv] = await h.db.insert(t.conversations).values({ contactId: contact!.id }).returning();
    // Asked three days ago, and two hours ago: only the first is overdue.
    await h.db.insert(t.requests).values({ conversationId: conv!.id, contactId: contact!.id, eventId: OLD_ASK, state: 'recommendation_sent', createdAt: new Date(now.getTime() - 72 * H) });
    await h.db.insert(t.requests).values({ conversationId: conv!.id, contactId: contact!.id, eventId: NEW_ASK, state: 'recommendation_sent', createdAt: new Date(now.getTime() - 2 * H) });
  });
  afterAll(async () => {
    await h.close();
  });

  it('is found from when it was asked about, not from a request made an hour ago', async () => {
    const gaps = await marketGaps(h.db, now);
    expect(gaps.map((g) => g.eventId)).toEqual([OLD_ASK]);
    expect(gaps[0]!.lastCheckAt).toBeNull();
    expect(gaps[0]!.tracked).toBeNull();
  });

  it('names the licence when it does not allow tracking, and that no pass was ever recorded', async () => {
    const d = await trackingDiagnosis(h.db, env, now);
    expect(d.licence.tracking).toBe(false);
    expect(d.lastPass).toBeNull();
    const causes = likelyCause(d, await marketGaps(h.db, now), now);
    expect(causes.join(' ')).toMatch(/licence on \/admin\/market doesn't allow tracking/);
    expect(causes.join(' ')).toMatch(/No hourly tracking pass has ever been recorded/);
    expect(causes.join(' ')).toMatch(/isn't enrolled/);
  });

  it('a passed "keep data until" date is said as the reason tracking stopped', async () => {
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking'], rawRetentionUntil: new Date('2026-10-10T00:00:00Z') }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    const causes = likelyCause(await trackingDiagnosis(h.db, env, now), [], now);
    expect(causes.join(' ')).toMatch(/"keep data until" date \(2026-10-10\) has passed/);
    await h.db.update(t.marketDatasets).set({ rawRetentionUntil: null }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  });

  it('a payment refusal stops the pass, and the pass record says so', async () => {
    const fetchImpl = (async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/v1/events/search') return new Response(JSON.stringify({ error: { type: 'payment_required', message: 'card declined' } }), { status: 402 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    // Live mode: enrolment follows real (non-fixture) events, as production does.
    const tracker = new MarketTracker({ db: h.db, env: testEnv({ SEATDATA_API_KEY: KEY, APP_MODE: 'live' }), now: () => now, fetchImpl, sleep: async () => {} });
    const r = await tracker.run();
    expect(r.skipped).toBeUndefined();
    expect(r.due).toBeGreaterThan(0);
    expect(r.stoppedBy).toBe('payment_required:402');
    // The hourly job records every pass (inngest/functions runMarketTracking); recorded here as it would be.
    await audit(h.db, { actor: 'system', action: 'market.tracking_pass', entityKind: 'system', entityId: 'market', diff: r });
    const d = await trackingDiagnosis(h.db, env, now);
    expect(d.lastPass?.stoppedBy).toBe('payment_required:402');
    expect(d.lastAccountError?.detail).toMatch(/^payment_required/);
    expect(likelyCause(d, await marketGaps(h.db, now), now).join(' ')).toMatch(/SeatData refused the account/);
  });

  it('sends one staff email a day, with the game and the cause, never the customer', async () => {
    const provider = new RecordingProvider();
    const first = await alertMarketGaps(h.db, env, provider, now);
    expect(first).toMatchObject({ outcome: 'sent', gaps: 1 });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toBe('ops@ticketguy.example');
    expect(provider.sent[0]!.subject).toMatch(/1 requested game hasn’t had a SeatData check in 36h/);
    expect(provider.sent[0]!.text).toMatch(/Gap Rangers vs\. Canadiens, 2026-11-16: never checked/);
    expect(provider.sent[0]!.text).not.toMatch(/gap@customer\.example/);
    const again = await alertMarketGaps(h.db, env, provider, new Date(now.getTime() + 2 * H));
    expect(again).toMatchObject({ outcome: 'skipped', reason: 'already_sent_today' });
    expect(provider.sent).toHaveLength(1);
  });

  it('a successful check inside 36 hours clears it', async () => {
    await h.db.insert(t.marketFetches).values({ provider: SEATDATA_PROVIDER, kind: 'stats', eventId: OLD_ASK, status: 'success', calls: 1, points: 3, at: new Date(now.getTime() - 5 * H) });
    expect(await marketGaps(h.db, now)).toEqual([]);
    expect(await alertMarketGaps(h.db, env, new RecordingProvider(), new Date(now.getTime() + 30 * H))).toMatchObject({ outcome: 'none' });
  });
});
