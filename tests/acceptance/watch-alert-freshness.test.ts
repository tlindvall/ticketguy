import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX, FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { setKillSwitch } from '@/lib/email/send-gate';
import { TEST_MODE_KEY } from '@/lib/email/test-mode';
import { openTestDb, makeConcierge, inbound, testEnv, RecordingProvider } from '../harness';

/**
 * R2-WATCH-FRESH-01: an alert approved on fresh evidence passed dispatch after that evidence expired, saying
 * "now $X" about a quote the app itself judged stale. Freshness is decided at send time, against the alert's own
 * observation, with the same windows as everywhere else (5 minutes inside 24h of the event, otherwise 15; an older
 * source as-of wins over a newer fetch). Captured and real sends go through the same check.
 */
describe('a watch alert sends only on evidence still fresh at dispatch', () => {
  let h: DbHandle;
  let clock = FIXTURE_NOW;
  const provider = new RecordingProvider();
  const who = (k: string) => `fresh-${k}@customer.example`;
  const KEYS = ['fresh', 'stale', 'cached', 'near', 'mismatch', 'real-fresh', 'real-stale', 'cancelled'];
  const intakeEnv = testEnv({ WATCH_SEND_ENABLED: 'true' });
  // Sendable apart from the evidence: live mode, sending on, every customer allowlisted.
  const sendEnv = testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', EXTRACTION_PROVIDER: 'rules', WATCH_SEND_ENABLED: 'true', EMAIL_TEST_RECIPIENT_ALLOWLIST: KEYS.map(who).join(',') });
  const intake = () => makeConcierge(h, { env: intakeEnv, now: () => clock });
  const sender = () => makeConcierge(h, { env: sendEnv, provider, now: () => clock });
  const testMode = (on: boolean) => setKillSwitch(h.db, TEST_MODE_KEY, on, 'staff-1', on ? 'test mode on' : 'test mode off');
  const at = (minutes: number, base: Date) => new Date(base.getTime() + minutes * 60_000);

  /** A watch on the Rangers game whose first evaluation (at `evaluateAt`) found an alert, approved at that time. */
  const approvedAlert = async (key: string, evaluateAt: Date, adjust?: (obsId: string) => Promise<void>) => {
    clock = FIXTURE_NOW;
    const r = (await intake().ingestInbound(inbound({ text: 'Rangers Oct 3, 2 tickets together, $350 total including fees. Please watch this for me.', from: who(key), subject: `Watch ${key}` }))) as { requestId: string };
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now: clock })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await intake().interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, clock);
    }
    const [w] = await h.db.select().from(t.watches).where(eq(t.watches.requestId, r.requestId));
    clock = evaluateAt;
    await h.db.update(t.watches).set({ nextCheckAt: clock }).where(eq(t.watches.id, w!.id));
    await intake().evaluateDueWatches(50);
    const [alert] = await h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.watchId, w!.id));
    // An approved manual observation rather than fixture content, so nothing but freshness stands in the way.
    await h.db.update(t.offerObservations).set({ verificationMethod: 'approved_manual' }).where(eq(t.offerObservations.id, alert!.observationId!));
    await adjust?.(alert!.observationId!);
    const approval = await sender().approveWatchAlert({ alertId: alert!.id, reviewerUserId: 'staff' });
    expect(approval).toMatchObject({ ok: true });
    return { alertId: alert!.id, sendIntentId: approval.sendIntentId!, watchId: w!.id };
  };
  const stateOf = async (sendIntentId: string) => (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.id, sendIntentId)))[0]!;
  const alertState = async (alertId: string) => (await h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.id, alertId)))[0]!.approvalState;
  const watchState = async (watchId: string) => (await h.db.select().from(t.watches).where(eq(t.watches.id, watchId)))[0]!.state;

  const FAR = new Date('2026-09-25T15:00:00Z'); // the game is days away: 15-minute window
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('captures the alert while its evidence is fresh', async () => {
    await testMode(true);
    const a = await approvedAlert('fresh', FAR);
    clock = FAR;
    expect(await sender().dispatchSend(a.sendIntentId)).toEqual({ outcome: 'sent' });
    expect((await stateOf(a.sendIntentId)).state).toBe('provider_accepted');
    expect(provider.sent).toHaveLength(0);
  });

  it('withholds an alert approved fresh once its evidence is stale at dispatch', async () => {
    await testMode(true);
    const a = await approvedAlert('stale', FAR);
    clock = at(20, FAR);
    const r = await sender().dispatchSend(a.sendIntentId);
    expect(r.outcome).toBe('blocked');
    expect(r.reasons).toContain('evidence_stale');
    expect(r.reasons).not.toContain('not_approved');
    expect((await stateOf(a.sendIntentId)).state).toBe('blocked');
    expect((await h.db.select().from(t.messages).where(eq(t.messages.providerEmailId, (await stateOf(a.sendIntentId)).providerMessageId ?? 'none'))).length).toBe(0);
    expect(provider.sent).toHaveLength(0);
    // The approval doesn't outlive its evidence; the watch itself keeps running and can find a current quote.
    expect(await alertState(a.alertId)).toBe('invalidated');
    expect(await watchState(a.watchId)).toBe('active');
    // A retry of the same intent sends nothing either.
    expect(await sender().dispatchSend(a.sendIntentId)).toMatchObject({ outcome: 'already_handled' });
  });

  it('judges a cached feed by its older as-of, not by the fetch', async () => {
    await testMode(true);
    // Fetched at approval, but the source's data was already 10 minutes old: fresh then, 16 minutes old 6 later.
    const a = await approvedAlert('cached', FAR, async (id) => {
      await h.db.update(t.offerObservations).set({ fetchedAt: FAR, sourceAsOf: at(-10, FAR) }).where(eq(t.offerObservations.id, id));
    });
    clock = at(6, FAR);
    expect(await sender().dispatchSend(a.sendIntentId)).toMatchObject({ outcome: 'blocked', reasons: expect.arrayContaining(['evidence_stale']) });
  });

  it('uses the five-minute window inside 24 hours of the event', async () => {
    await testMode(true);
    const [watched] = await h.db.select({ eventId: t.watches.eventId }).from(t.watches).limit(1);
    const [event] = await h.db.select().from(t.events).where(eq(t.events.id, watched!.eventId));
    const near = at(-6 * 60, event!.localStartAt);
    const a = await approvedAlert('near', near);
    clock = at(6, near); // within 15 minutes, past 5
    expect(await sender().dispatchSend(a.sendIntentId)).toMatchObject({ outcome: 'blocked', reasons: expect.arrayContaining(['evidence_stale']) });
  });

  it('withholds an alert whose observation is not for the watched event', async () => {
    await testMode(true);
    const a = await approvedAlert('mismatch', FAR);
    const [alert] = await h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.id, a.alertId));
    await h.db.update(t.offerObservations).set({ eventId: FX.events.knicks }).where(eq(t.offerObservations.id, alert!.observationId!));
    clock = FAR;
    expect(await sender().dispatchSend(a.sendIntentId)).toMatchObject({ outcome: 'blocked', reasons: expect.arrayContaining(['evidence_stale']) });
  });

  it('applies the same check to a real provider send', async () => {
    await testMode(false);
    const fresh = await approvedAlert('real-fresh', FAR);
    const stale = await approvedAlert('real-stale', FAR);
    clock = FAR;
    expect(await sender().dispatchSend(fresh.sendIntentId)).toEqual({ outcome: 'sent' });
    expect(provider.sent).toHaveLength(1);
    clock = at(20, FAR);
    expect(await sender().dispatchSend(stale.sendIntentId)).toMatchObject({ outcome: 'blocked', reasons: expect.arrayContaining(['evidence_stale']) });
    expect(provider.sent).toHaveLength(1);
  });

  // R2-LIFECYCLE-01, for watches. Last: it cancels the event every case here watches.
  it('withholds a fresh alert once the event is cancelled, and pauses the watch', async () => {
    await testMode(true);
    const a = await approvedAlert('cancelled', FAR);
    const [w] = await h.db.select().from(t.watches).where(eq(t.watches.id, a.watchId));
    await h.db.update(t.events).set({ status: 'cancelled' }).where(eq(t.events.id, w!.eventId));
    clock = FAR;
    expect(await sender().dispatchSend(a.sendIntentId)).toMatchObject({ outcome: 'blocked', reasons: expect.arrayContaining(['event_cancelled']) });
    expect(await alertState(a.alertId)).toBe('invalidated');
    await h.db.update(t.watches).set({ nextCheckAt: clock }).where(eq(t.watches.id, a.watchId));
    await intake().evaluateDueWatches(50);
    expect((await h.db.select().from(t.watches).where(eq(t.watches.id, a.watchId)))[0]).toMatchObject({ state: 'paused', pauseReason: 'event_cancelled' });
  });
});
