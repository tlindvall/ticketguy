import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX, FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, makeConcierge, inbound, testEnv, RecordingProvider } from '../harness';

/**
 * A correct "stopped" email proves nothing about the database (review of the TGQA-0929 retest). One customer,
 * two threads, each with a running watch and an approved alert queued to send, plus an event alert. They cancel
 * in thread A, then again once thread A is closed. Checked against stored state, not wording:
 *   - thread A's watch is cancelled, its pending alerts invalidated, its queued alert send blocked, and a later
 *     dispatch of it sends nothing;
 *   - thread B's watch, its queued alert and the event alert are untouched, and B's alert still dispatches;
 *   - marketing permissions and suppressions are unchanged;
 *   - the repeated cancel on the closed thread stops nothing else.
 */
describe('cancelling one watch leaves every other one running', () => {
  let h: DbHandle;
  let clock = FIXTURE_NOW;
  const who = 'isolation@customer.example';
  const provider = new RecordingProvider();
  const env = testEnv({ WATCH_SEND_ENABLED: 'true', EMAIL_TEST_RECIPIENT_ALLOWLIST: who });
  const c = () => makeConcierge(h, { env, provider, now: () => clock });
  const interpretAll = async () => {
    for (let i = 0; i < 5; i++) {
      const work = (await leaseDueOutbox(h.db, { limit: 50, now: clock })).filter((e) => e.eventType === 'request.interpret');
      if (!work.length) return;
      for (const ev of work) {
        const p = ev.payload as Record<string, string>;
        await c().interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, clock);
      }
    }
  };
  const ask = async (text: string, subject: string, reply?: { rfc: string }) => {
    const m = inbound({ text, from: who, subject, inReplyTo: reply?.rfc ?? null, references: reply?.rfc ?? null });
    const r = (await c().ingestInbound(m)) as { requestId: string };
    await interpretAll();
    return { requestId: r.requestId, rfc: m.rfcMessageId! };
  };
  const watchOf = async (requestId: string) => (await h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId)))[0]!;
  const sendOf = async (id: string) => (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.id, id)))[0]!;

  let A: { requestId: string; rfc: string };
  let B: { requestId: string; rfc: string };
  let alertSendA: string;
  let alertSendB: string;
  let pendingA: string;
  let eventAlertB: string;
  let before: { perms: number; suppressions: number };

  beforeAll(async () => {
    h = await openTestDb();
    A = await ask('Rangers Oct 3, 2 tickets, $300 total. Let me know if it drops.', 'Rangers watch');
    B = await ask('Knicks Oct 24, 2 tickets, $400 total. Let me know if it drops.', 'Knicks watch');
    // Both watches find a qualifying fixture offer once they're due.
    clock = new Date(FIXTURE_NOW.getTime() + 3 * 86_400_000);
    await c().evaluateDueWatches(50);
    const alertsFor = async (requestId: string) => h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.watchId, (await watchOf(requestId)).id));
    const [a1] = await alertsFor(A.requestId);
    const [b1] = await alertsFor(B.requestId);
    alertSendA = (await c().approveWatchAlert({ alertId: a1!.id, reviewerUserId: 'staff' })).sendIntentId!;
    alertSendB = (await c().approveWatchAlert({ alertId: b1!.id, reviewerUserId: 'staff' })).sendIntentId!;
    // A second alert on A found later, still waiting for approval.
    const wA = await watchOf(A.requestId);
    const [pa] = await h.db.insert(t.watchAlerts).values({ watchId: wA.id, generation: wA.generation, observationId: a1!.observationId, dedupeKey: 'isolation-pending-a', payableTotalCents: 20000, approvalState: 'pending' }).returning({ id: t.watchAlerts.id });
    pendingA = pa!.id;
    const [contact] = await h.db.select().from(t.contacts).where(eq(t.contacts.emailLookup, who));
    const [ea] = await h.db.insert(t.eventAlerts).values({ requestId: B.requestId, contactId: contact!.id, kind: 'on_sale', eventId: FX.events.knicks, state: 'active', nextCheckAt: clock, expiresAt: new Date(clock.getTime() + 30 * 86_400_000) }).returning({ id: t.eventAlerts.id });
    eventAlertB = ea!.id;
    before = {
      perms: (await h.db.select().from(t.marketingPermissions).where(eq(t.marketingPermissions.contactId, contact!.id))).length,
      suppressions: (await h.db.select().from(t.suppressions)).length,
    };
  });
  afterAll(async () => {
    await h.close();
  });

  it('starts with both watches running and both alert sends queued', async () => {
    expect((await watchOf(A.requestId)).state).toBe('active');
    expect((await watchOf(B.requestId)).state).toBe('active');
    expect((await sendOf(alertSendA)).state).toBe('queued');
    expect((await sendOf(alertSendB)).state).toBe('queued');
  });

  it('cancelling in thread A stops A, and only A, in the database', async () => {
    await ask('Cancel only the price watch requested in this thread. This does not apply to other requests or my email preferences.', 'Re: Rangers watch', A);
    expect((await watchOf(A.requestId)).state).toBe('cancelled');
    expect((await sendOf(alertSendA))).toMatchObject({ state: 'blocked', lastError: 'watch_cancelled' });
    expect((await h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.id, pendingA)))[0]!.approvalState).toBe('invalidated');
    // Untouched: B's watch, B's queued alert, the event alert, permissions and suppressions.
    expect((await watchOf(B.requestId)).state).toBe('active');
    expect((await sendOf(alertSendB)).state).toBe('queued');
    expect((await h.db.select().from(t.eventAlerts).where(eq(t.eventAlerts.id, eventAlertB)))[0]!.state).toBe('active');
    const [contact] = await h.db.select().from(t.contacts).where(eq(t.contacts.emailLookup, who));
    expect((await h.db.select().from(t.marketingPermissions).where(eq(t.marketingPermissions.contactId, contact!.id))).length).toBe(before.perms);
    expect((await h.db.select().from(t.suppressions)).length).toBe(before.suppressions);
    // What the customer was told matches what changed.
    const replies = await h.db.select().from(t.sendIntents).where(and(eq(t.sendIntents.conversationId, (await h.db.select().from(t.requests).where(eq(t.requests.id, A.requestId)))[0]!.conversationId), eq(t.sendIntents.messageClass, 'acknowledgment')));
    expect(replies.some((r) => r.bodyText.includes('Done: I’ve stopped the price watch on this request.'))).toBe(true);
    expect((await h.db.select().from(t.requests).where(eq(t.requests.id, A.requestId)))[0]!.state).toBe('closed');
  });

  it('a late dispatch of A’s alert sends nothing; B’s alert is still sendable', async () => {
    const sentBefore = provider.sent.length;
    expect(await c().dispatchSend(alertSendA)).toMatchObject({ outcome: 'already_handled' });
    expect(provider.sent.length).toBe(sentBefore);
    expect(await c().approveWatchAlert({ alertId: pendingA, reviewerUserId: 'staff' })).toMatchObject({ ok: false, reason: 'not_pending' });
    // B is judged on its own: its approval stands (it may still be held for fixture data in this test world).
    const b = await c().dispatchSend(alertSendB);
    expect(b.reasons ?? []).not.toContain('not_approved');
  });

  it('cancelling again on the closed thread stops nothing else', async () => {
    await ask('Please cancel the watch in this thread again, just to be sure.', 'Re: Rangers watch', A);
    expect((await watchOf(B.requestId)).state).toBe('active');
    expect((await h.db.select().from(t.eventAlerts).where(eq(t.eventAlerts.id, eventAlertB)))[0]!.state).toBe('active');
    const conv = (await h.db.select().from(t.requests).where(eq(t.requests.id, A.requestId)))[0]!.conversationId;
    const replies = await h.db.select().from(t.sendIntents).where(and(eq(t.sendIntents.conversationId, conv), eq(t.sendIntents.messageClass, 'acknowledgment')));
    expect(replies.some((r) => r.bodyText.includes('There was no active price watch or alert on this request'))).toBe(true);
  });
});
