import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv, RecordingProvider } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { setKillSwitch } from '@/lib/email/send-gate';
import { TEST_MODE_KEY } from '@/lib/email/test-mode';

/**
 * A price watch on SeatData's resale listings (DECISION_LOG #62), against a fake SeatData shaped like its payloads:
 * "4 together for less than $400, alert me". No seller can be monitored, as in production. The watch exists only
 * when the licence allows alerts (or tracking while email goes only to the owner's testers); each look is one
 * listings read; an alert is a heads-up on listed prices with the fee allowance said, approved by staff, and as
 * fresh as the read behind it.
 */
const MIN = 60_000;
const KEY = 'ab'.repeat(32);

describe('a price watch on SeatData resale listings', () => {
  let h: DbHandle;
  let now = FIXTURE_NOW;
  let listings: Array<Record<string, unknown>> = [];
  let reads = 0;
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      if (url.searchParams.get('tm_event_id') === 'TMWATCH1') return json({ data: [{ event_id: 555, tm_event_id: 'TMWATCH1', event_name: 'Metro Watchers vs. Boston', event_date: '2026-10-30', venue_name: 'Watch Garden', venue_city: 'New York', venue_state: 'NY' }], has_more: false, next_cursor: null });
      return json({ data: [], has_more: false, next_cursor: null });
    }
    if (url.pathname === '/api/v1/events/555/stats') return json({ event_id: 555, data: [], has_more: false, next_cursor: null });
    if (url.pathname === '/api/v1/events/555/sales') return json({ event_id: 555, data: [], has_more: false, next_cursor: null });
    if (url.pathname === '/api/v0.1/listings/get' && url.searchParams.get('event_id') === '555') {
      reads += 1;
      return json({ has_refreshed: true, listings });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const customers = ['watch-a@customer.example', 'watch-b@customer.example', 'watch-c@customer.example', 'watch-d@customer.example', 'watch-e@customer.example', 'watch-f@customer.example'];
  // Email unrestricted (no tester allowlist), so only the licence's alerts use lets SeatData watch.
  const env = (over: Record<string, string> = {}) => testEnv({ SEATDATA_API_KEY: KEY, WATCH_SEND_ENABLED: 'true', EMAIL_TEST_RECIPIENT_ALLOWLIST: '', ...over });
  const concierge = (over: Record<string, string> = {}, provider: RecordingProvider | null = null) => new Concierge({ db: h.db, env: env(over), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: provider, marketFetch: fetchImpl });
  const setLicence = (uses: string[]) => h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: uses, licenseReference: 'test: SeatData email 2026-10-01, alerts to customers allowed' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  const ASK = 'Watchers Oct 30, 4 tickets together, $400 total including fees. Please watch this for me and alert me if you find them.';
  const ask = async (c: Concierge, text: string, from: string) => {
    const r = (await c.ingestInbound(inbound({ text, from, subject: 'Watchers' }))) as { requestId: string };
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, now);
    }
    return r.requestId;
  };
  const watchFor = async (requestId: string) => (await h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId)))[0];
  const alertsFor = async (watchId: string) => h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.watchId, watchId));
  // Only this watch is due: earlier cases' watches are moved out of the way.
  const evaluateAt = async (watchId: string, at: Date) => {
    now = at;
    await h.db.update(t.watches).set({ nextCheckAt: new Date('2026-10-29T00:00:00Z') }).where(ne(t.watches.id, watchId));
    await h.db.update(t.watches).set({ nextCheckAt: at }).where(eq(t.watches.id, watchId));
    return concierge().evaluateDueWatches(50);
  };
  const listing = (id: number, price: number, quantity: number, active = true) => ({ active, listing_id: id, price, quantity, quantity_start: quantity, row: '8', section: '215', zone: 'Upper' });

  const ARENA = '10000000-0000-4000-8000-0000000000e1';
  const TEAM = '20000000-0000-4000-8000-0000000000e1';
  const GAME = '30000000-0000-4000-8000-0000000000e1';
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Watch Garden', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Watchers', slug: 'metro-watchers', aliases: ['Watchers'], league: 'NBA', homeVenueId: ARENA });
    await h.db.insert(t.events).values({ id: GAME, name: 'Metro Watchers vs. Boston', category: 'nba', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-10-30T23:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: false });
    // No seller can be monitored: SeatData is the only possible watch source, as in production.
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME, sourceId: 'ticketmaster', sourceEventId: 'TMWATCH1', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMWATCH1', role: 'discovery', confidence: 'provider_id' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('tracking alone, with email open to anyone: no watch is stored, and the reply says nothing is watched', async () => {
    await setLicence(['tracking']);
    const c = concierge();
    const requestId = await ask(c, ASK, customers[0]!);
    expect(await watchFor(requestId)).toBeUndefined();
    const notCreated = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'watch.not_created'), eq(t.auditLog.entityId, requestId)));
    expect(notCreated.map((a) => (a.diff as { reason: string }).reason)).toEqual(['no_monitoring_coverage']);
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    expect(rec!.bodyText).toContain('I can’t watch prices for you yet');
  });

  it('with alerts licensed: a SeatData watch is stored, followed on SeatData, and the reply says exactly what it watches', async () => {
    await setLicence(['tracking', 'alerts']);
    const c = concierge();
    const requestId = await ask(c, ASK, customers[1]!);
    const w = await watchFor(requestId);
    expect(w).toMatchObject({ state: 'active', quantity: 4, targetTotalCents: 40000 });
    expect((w!.constraints as { monitor?: string }).monitor).toBe('market');
    // No more often than every three hours (each look is a paid read); the first look is minutes away.
    expect(w!.cadenceMinutes).toBeGreaterThanOrEqual(180);
    expect(w!.nextCheckAt.getTime() - now.getTime()).toBe(5 * MIN);
    const [tr] = await h.db.select().from(t.trackedEvents).where(eq(t.trackedEvents.eventId, GAME));
    expect(tr).toMatchObject({ state: 'active', providerEventId: '555' });
    await c.research({ requestId, revision: 1 });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    expect(rec!.bodyText).toContain('I’m watching resale listings for this: if listings with 4 or more tickets show up at a price that, with fees of up to 30%, fits your $400 in total, I’ll email you a heads-up.');
    expect(rec!.bodyText).toContain('I won’t have a link to the seats and can’t promise they’re together or sold in exactly 4');
    expect(rec!.bodyText).not.toContain('I’m watching this for you');
  });

  it('a look finds a listing for 4+ that fits with the fee allowance: one pending alert carrying what it saw; smaller and inactive listings are ignored', async () => {
    const requestId = await ask(concierge(), ASK, customers[2]!);
    const w = (await watchFor(requestId))!;
    listings = [listing(1, 40, 2), listing(2, 30, 8, false), listing(3, 75, 4), listing(4, 82, 6)];
    const before = reads;
    expect(await evaluateAt(w.id, new Date(FIXTURE_NOW.getTime() + 10 * MIN))).toMatchObject({ alertsCreated: 1 });
    expect(reads - before).toBe(1);
    const [alert] = await alertsFor(w.id);
    expect(alert).toMatchObject({ observationId: null, approvalState: 'pending', payableTotalCents: 39000 });
    expect(alert!.market).toMatchObject({ basis: '4+', listedPerTicketCents: 7500, listedTotalCents: 30000, estimatedTotalCents: 39000, feeAllowancePct: 30, listings: 2, isFixture: false });
    // The same price again is not news.
    expect(await evaluateAt(w.id, new Date(FIXTURE_NOW.getTime() + 4 * 60 * MIN))).toMatchObject({ alertsCreated: 0 });
    expect(await alertsFor(w.id)).toHaveLength(1);
  });

  it('a listing that fits only before fees is not an alert ($80 × 4 = $320, about $416 with 30%)', async () => {
    const requestId = await ask(concierge(), ASK, customers[3]!);
    const w = (await watchFor(requestId))!;
    listings = [listing(5, 80, 4), listing(6, 60, 3)];
    expect(await evaluateAt(w.id, new Date(FIXTURE_NOW.getTime() + 10 * MIN))).toMatchObject({ alertsCreated: 0 });
    expect(await alertsFor(w.id)).toHaveLength(0);
  });

  it('approved while fresh: the heads-up says listed prices, the fee assumption and what the data cannot show, and it sends', async () => {
    const provider = new RecordingProvider();
    const requestId = await ask(concierge(), ASK, customers[4]!);
    const w = (await watchFor(requestId))!;
    listings = [listing(7, 75, 4)];
    const found = new Date(FIXTURE_NOW.getTime() + 10 * MIN);
    await evaluateAt(w.id, found);
    const [alert] = await alertsFor(w.id);
    now = new Date(found.getTime() + 30 * MIN);
    const sendEnv = { APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', EXTRACTION_PROVIDER: 'rules' };
    const approval = await concierge(sendEnv, provider).approveWatchAlert({ alertId: alert!.id, reviewerUserId: 'staff' });
    expect(approval).toMatchObject({ ok: true });
    const [intent] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.id, approval.sendIntentId!));
    // In the customer's own thread, so it keeps their subject.
    expect(intent!.subject).toBe('Re: Watchers');
    expect(intent!.bodyText).toContain('Heads-up: resale listings with 4 or more tickets for Metro Watchers vs. Boston at Watch Garden, New York');
    expect(intent!.bodyText).toContain('now start at $75 a ticket before fees, $300 for four.');
    expect(intent!.bodyText).toContain('With fees of up to 30%, that’s about $390 all in, inside your $400.');
    expect(intent!.bodyText).toContain('not a ticket I’ve checked: I don’t have a link to it, it may be gone when you look, and a listing of 4 or more may not sell exactly four or be seats together.');
    expect(intent!.bodyText).not.toMatch(/SeatData|found them|verified|guarantee/i);
    expect(intent!.bodyText).toContain('human-reviewed');
    await setKillSwitch(h.db, TEST_MODE_KEY, true, 'staff-1', 'capture');
    expect(await concierge(sendEnv, provider).dispatchSend(approval.sendIntentId!)).toEqual({ outcome: 'sent' });
    await setKillSwitch(h.db, TEST_MODE_KEY, false, 'staff-1', 'capture off');
  });

  it('an alert is only as fresh as its read: approval four hours later invalidates it, and a revoked alerts licence pauses the watch', async () => {
    const requestId = await ask(concierge(), ASK, customers[5]!);
    const w = (await watchFor(requestId))!;
    listings = [listing(8, 70, 5)];
    const found = new Date(FIXTURE_NOW.getTime() + 10 * MIN);
    await evaluateAt(w.id, found);
    const [alert] = await alertsFor(w.id);
    now = new Date(found.getTime() + 4 * 60 * MIN);
    expect(await concierge().approveWatchAlert({ alertId: alert!.id, reviewerUserId: 'staff' })).toEqual({ ok: false, reason: 'stale_observation' });
    expect((await alertsFor(w.id))[0]!.approvalState).toBe('invalidated');
    await setLicence(['tracking']);
    await evaluateAt(w.id, new Date(now.getTime() + 10 * MIN));
    expect(await watchFor(requestId)).toMatchObject({ state: 'paused', pauseReason: 'capability:monitoring_unavailable' });
    await setLicence(['tracking', 'alerts']);
  });

  it('a requirement listings cannot show (accessible seating) means no SeatData watch, said as such for staff', async () => {
    const requestId = await ask(concierge(), 'Watchers Oct 30, 4 tickets together, wheelchair accessible seating needed, $400 total including fees. Please watch this for me.', 'watch-g@customer.example');
    expect(await watchFor(requestId)).toBeUndefined();
    const notCreated = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'watch.not_created'), eq(t.auditLog.entityId, requestId)));
    expect(notCreated.map((a) => (a.diff as { reason: string }).reason)).toEqual(['market_unverifiable:accessible_seating']);
  });
});
