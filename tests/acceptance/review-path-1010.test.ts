import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { AUTO_APPROVER } from '@/lib/intake/pipeline';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';

/**
 * The review path between the draft and the send (CTO audit Oct 10, gap 3): a customer who wrote while their draft
 * waited for review heard nothing, and recommendations.expiresAt (15 minutes after the prices were read) was checked
 * nowhere, so a late approval sent old prices as current. Now a later message gets one line saying what changed and
 * that the answer is coming, and an expired draft is researched again, never sent. Auto-approval while testing is
 * unchanged: its answer follows in seconds, so no extra note.
 */
describe('review path: holding note on a later message, expired drafts researched again', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  const drain = async (c: ReturnType<typeof makeConcierge>, now = FIXTURE_NOW) => {
    for (let i = 0; i < 10; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now });
      if (!leased.length) return;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    }
  };
  const TEXT = 'Two Rangers tickets Oct 3, $300 total. Should I buy now?';
  const reviewed = () => testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: '' });
  const recs = (requestId: string) => h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
  const ask = async (who: string, env = reviewed()) => {
    const c = makeConcierge(h, { env });
    const first = inbound({ text: TEXT, from: who, subject: 'Rangers' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await drain(c);
    return { c, first, requestId: r.requestId };
  };
  const later = (minutes: number) => new Date(FIXTURE_NOW.getTime() + minutes * 60_000);

  it('a correction while the draft waits for review gets one line: what changed, and that the answer is coming', async () => {
    const who = 'waiting@customer.example';
    const { c, first, requestId } = await ask(who);
    const [rec1] = await recs(requestId);
    expect(rec1!.reviewStatus).toBe('pending');
    await c.ingestInbound(inbound({ text: 'Actually make that four tickets, still $300 total.', from: who, subject: 'Re: Rangers', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await drain(c);
    expect((await h.db.select().from(t.recommendations).where(eq(t.recommendations.id, rec1!.id)))[0]!.reviewStatus).toBe('invalidated');
    const notes = (await h.db.select().from(t.sendIntents).where(and(eq(t.sendIntents.requestId, requestId), eq(t.sendIntents.messageClass, 'acknowledgment'), eq(t.sendIntents.requestRevision, 2))));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.bodyText).toContain('Got your update: 4 tickets. I’m rechecking with that, and the updated answer will come here in this thread.');
    expect(notes[0]!.bodyText).not.toMatch(/[–—]|shortly|minutes|hours/);
    // And the updated draft is there for review.
    expect((await recs(requestId)).some((r) => r.revision === 2 && r.reviewStatus === 'pending')).toBe(true);
  });

  it('auto-approval while testing sends no extra note: the updated answer itself follows', async () => {
    const who = 'autonote@customer.example';
    const { c, first, requestId } = await ask(who, testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: who }));
    await c.ingestInbound(inbound({ text: 'Actually make that four tickets, still $300 total.', from: who, subject: 'Re: Rangers', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await drain(c);
    const sends = await h.db.select().from(t.sendIntents).where(and(eq(t.sendIntents.requestId, requestId), eq(t.sendIntents.requestRevision, 2)));
    expect(sends.some((s) => s.bodyText.includes('Got your update'))).toBe(false);
    expect((await recs(requestId)).find((r) => r.revision === 2)).toMatchObject({ reviewStatus: 'approved', reviewerUserId: AUTO_APPROVER });
  });

  it('an approval after the draft expired is refused, and the request is researched again for a fresh draft', async () => {
    const { requestId } = await ask('lateapproval@customer.example');
    const [rec] = await recs(requestId);
    expect(rec!.expiresAt!.getTime()).toBe(later(15).getTime());
    const t16 = later(16);
    const c16 = makeConcierge(h, { env: reviewed(), now: () => t16 });
    expect(await c16.approveRecommendation({ recommendationId: rec!.id, reviewerUserId: 'staff-1', expectedRevision: 1, draftHash: rec!.draftHash, note: null })).toEqual({ ok: false, status: 409, reason: 'recommendation_expired' });
    const [after] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.id, rec!.id));
    expect(after!.reviewStatus).toBe('invalidated');
    // Nothing queued for the customer from the expired draft.
    expect(await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.approvalId, rec!.id))).toHaveLength(0);
    expect(await h.db.select().from(t.outboxEvents).where(like(t.outboxEvents.eventKey, `research:${requestId}:1:expired:%`))).toHaveLength(1);
    await drain(c16, t16);
    const fresh = (await recs(requestId)).find((r) => r.id !== rec!.id)!;
    expect(fresh).toMatchObject({ revision: 1, reviewStatus: 'pending' });
    expect(fresh.expiresAt!.getTime()).toBe(later(31).getTime());
    expect((await c16.approveRecommendation({ recommendationId: fresh.id, reviewerUserId: 'staff-1', expectedRevision: 1, draftHash: fresh.draftHash, note: null })).ok).toBe(true);
  });

  it('a draft approved in time but dispatched after it expired is withheld and researched again, never sent', async () => {
    const { c, requestId } = await ask('latedispatch@customer.example');
    const [rec] = await recs(requestId);
    const ok = await c.approveRecommendation({ recommendationId: rec!.id, reviewerUserId: 'staff-1', expectedRevision: 1, draftHash: rec!.draftHash, note: null });
    expect(ok.ok).toBe(true);
    const t20 = later(20);
    const c20 = makeConcierge(h, { env: reviewed(), now: () => t20 });
    const sent = await c20.dispatchSend((ok as { sendIntentId: string }).sendIntentId);
    expect(sent.outcome).toBe('blocked');
    expect(sent.reasons).toContain('recommendation_expired');
    expect((await h.db.select().from(t.recommendations).where(eq(t.recommendations.id, rec!.id)))[0]!.reviewStatus).toBe('invalidated');
    await drain(c20, t20);
    expect((await recs(requestId)).filter((r) => r.reviewStatus === 'pending')).toHaveLength(1);
  });

  it('within its fifteen minutes the draft approves as before', async () => {
    const { requestId } = await ask('intime@customer.example');
    const [rec] = await recs(requestId);
    const c14 = makeConcierge(h, { env: reviewed(), now: () => later(14) });
    expect((await c14.approveRecommendation({ recommendationId: rec!.id, reviewerUserId: 'staff-1', expectedRevision: 1, draftHash: rec!.draftHash, note: null })).ok).toBe(true);
  });
});
