import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { removeRequests, REMOVED_REASON } from '@/lib/admin/remove-requests';
import { FIXTURE_NOW } from '@/lib/fixtures';

/**
 * Testing leaves stale requests on the board. Removing one closes it (nothing is deleted) and stops
 * everything still pending for it, so nothing goes out afterwards; the customer's next email starts afresh.
 */
describe('removing requests from the board', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('closes the request, holds back what was queued, drops pending work, and a later email opens a new request', async () => {
    const c = makeConcierge(h);
    const first = inbound({ text: 'Two Rangers tickets Oct 3, $300 total.', from: 'stale@customer.example', subject: 'Rangers' });
    const r = await c.ingestInbound(first);
    const requestId = (r as { requestId: string }).requestId;
    // Nothing interpreted yet: the interpret job is still pending in the outbox. Add a queued email as well.
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    const [contact] = await h.db.select().from(t.contacts).where(eq(t.contacts.id, req!.contactId));
    const queued = await c.queueSend({ messageClass: 'clarification', contactId: contact!.id, conversationId: req!.conversationId, requestId, revision: 1, recipient: contact!.emailOriginal, subject: 'Re: Rangers', template: 'clarification', vars: { acknowledgement: 'Two Rangers tickets.', questions: ['Which game?'] }, inReplyTo: first.rfcMessageId, approvalId: null, approvedHash: null });

    const res = await removeRequests(h.db, { requestIds: [requestId], staffUserId: 'staff-1', now: FIXTURE_NOW });
    expect(res.removed).toEqual([requestId]);

    const [after] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(after!.state).toBe('closed');
    const [move] = await h.db.select().from(t.requestTransitions).where(and(eq(t.requestTransitions.requestId, requestId), eq(t.requestTransitions.toState, 'closed')));
    expect(move).toMatchObject({ actor: 'staff-1', reason: REMOVED_REASON });
    const [intent] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.id, queued.id));
    expect(intent!.state).toBe('blocked');
    const pending = await h.db.select().from(t.outboxEvents).where(and(eq(t.outboxEvents.entityId, requestId), eq(t.outboxEvents.state, 'pending')));
    expect(pending).toHaveLength(0);
    const [audited] = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId, requestId), eq(t.auditLog.action, 'request.removed')));
    expect(audited).toBeTruthy();

    // A dispatcher that finds the held-back email does not send it.
    expect((await c.dispatchSend(queued.id)).outcome).toBe('already_handled');

    // Removing twice is harmless.
    expect((await removeRequests(h.db, { requestIds: [requestId], staffUserId: 'staff-1', now: FIXTURE_NOW })).removed).toEqual([]);

    // The customer writes again in the same thread: a new request, not the removed one.
    const again = await c.ingestInbound(inbound({ text: 'Still after those Rangers tickets', from: 'stale@customer.example', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    expect((again as { requestId: string }).requestId).not.toBe(requestId);
  });
});
