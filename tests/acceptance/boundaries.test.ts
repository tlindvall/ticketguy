import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { INBOUND_PER_HOUR } from '@/lib/intake/boundaries';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';

async function interpretAll(h: DbHandle, c: ReturnType<typeof makeConcierge>) {
  for (let i = 0; i < 5; i++) {
    const leased = await leaseDueOutbox(h.db, { limit: 100, now: FIXTURE_NOW });
    const work = leased.filter((ev) => ev.eventType === 'request.interpret');
    if (!work.length) return;
    for (const ev of work) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
  }
}

/**
 * "Can you tell me something interesting about New York city? also, are you an idiot?" came back "Two tickets.
 * Got it. Which event…? I've assumed two tickets." A message that isn't about tickets now gets one short reply
 * saying what we do, and a sender who floods us gets no model calls and no replies.
 */
describe('boundaries', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  const sendsTo = (recipient: string) => h.db.select().from(t.sendIntents).where(eq(t.sendIntents.recipient, recipient));

  it('a first message that is not about tickets gets "I only do tickets", once a day, and nothing assumed', async () => {
    const c = makeConcierge(h);
    const from = 'offtopic@customer.example';
    const first = inbound({ text: 'Can you tell me something interesting about New york city?\n\nalso, are you an idiot?', from, subject: null });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await interpretAll(h, c);
    let sends = await sendsTo(from);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.bodyText).toContain('I only do tickets: sports, concerts and shows in the US.');
    expect(sends[0]!.bodyText).not.toMatch(/two tickets|assumed/i);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).toBe('closed');

    // A second one the same day, in a new thread: no reply.
    await c.ingestInbound(inbound({ text: 'what is the meaning of life', from, subject: 'hello' }));
    await interpretAll(h, c);
    sends = await sendsTo(from);
    expect(sends).toHaveLength(1);

    // A real request in reply to our note is answered as usual.
    await c.ingestInbound(inbound({ text: 'ok fine. Two Rangers tickets Oct 3 please', from, subject: 'Re: Ticket Guy does tickets', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(h, c);
    sends = await sendsTo(from);
    expect(sends.length).toBeGreaterThan(1);
    expect(sends.some((s) => /Rangers/.test(s.bodyText))).toBe(true);
  });

  it('real requests with no ticket word still go through: a team, a date, a link, a browse', async () => {
    const c = makeConcierge(h);
    for (const [i, text] of ['Knicks next Saturday?', 'anything fun on this weekend in brooklyn', 'https://www.stubhub.com/new-york-rangers-new-york-tickets-10-3-2026/event/1/?quantity=2'].entries()) {
      const from = `real${i}@customer.example`;
      await c.ingestInbound(inbound({ text, from, subject: null }));
      await interpretAll(h, c);
      const sends = await sendsTo(from);
      expect(sends.every((s) => !s.bodyText.includes('I only do tickets'))).toBe(true);
    }
  });

  it('a sender over the hourly limit gets no model call and no reply, and staff are told once', async () => {
    const c = makeConcierge(h);
    const from = 'flood@customer.example';
    for (let i = 0; i < INBOUND_PER_HOUR + 3; i++) {
      await c.ingestInbound(inbound({ text: `Two Knicks tickets please, message ${i}`, from, subject: `Knicks ${i}` }));
    }
    await interpretAll(h, c);
    const limited = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'intake.rate_limited')));
    const mine = limited.filter((a) => (a.diff as { messageId?: string }).messageId);
    expect(mine.length).toBe(3);
    expect(mine.filter((a) => (a.diff as { staffTold?: boolean }).staffTold).length).toBe(1);
    const alerts = await h.db.select().from(t.outboxEvents).where(like(t.outboxEvents.eventKey, 'staff_alert:%:rate_limited'));
    expect(alerts).toHaveLength(1);
    // The ten within the limit were answered; the three over it were not.
    const answered = new Set((await sendsTo(from)).map((s) => s.requestId));
    expect(answered.size).toBe(INBOUND_PER_HOUR);
  });

  it('an address on the test allowlist is ours, testing on purpose, and is not held to the limit', async () => {
    const from = 'tester@customer.example';
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: from }) });
    for (let i = 0; i < INBOUND_PER_HOUR + 3; i++) {
      await c.ingestInbound(inbound({ text: `Two Knicks tickets please, test ${i}`, from, subject: `Knicks test ${i}` }));
    }
    await interpretAll(h, c);
    const limited = (await h.db.select().from(t.auditLog).where(eq(t.auditLog.action, 'intake.rate_limited'))).filter((a) => String((a.diff as { messageId?: string }).messageId ?? '') && a.entityId !== null);
    const [contact] = await h.db.select().from(t.contacts).where(eq(t.contacts.emailLookup, from));
    expect(limited.filter((a) => a.entityId === contact!.id)).toHaveLength(0);
    expect(new Set((await sendsTo(from)).map((s) => s.requestId)).size).toBe(INBOUND_PER_HOUR + 3);
  });
});
