import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { evaluateGate } from '@/lib/email/send-gate';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';

async function drain(h: DbHandle, c: ReturnType<typeof makeConcierge>, now: Date) {
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
}

/**
 * Measuring whether we helped: every request is tagged with what the buyer needed; "I bought them" and "stop"
 * replies close it and stop any watching; one follow-up after the event asks whether the advice changed what
 * or when they bought; each outcome is kept as the kind of evidence it is.
 */
describe('pilot outcomes', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  const outcomes = (requestId: string) => h.db.select().from(t.requestOutcomes).where(eq(t.requestOutcomes.requestId, requestId));
  const env = (who: string) => testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: who });

  it('tags the request, records "we bought them", stops watching, and acknowledges without new advice', async () => {
    const who = 'bought@customer.example';
    const c = makeConcierge(h, { env: env(who) });
    const first = inbound({ text: 'Two Rangers tickets Oct 3, is $150 each a good price? Should I buy now or wait?', from: who, subject: 'Rangers' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await drain(h, c, FIXTURE_NOW);
    const [req0] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req0!.problemTypes).toEqual(['price_check', 'buy_or_wait']);
    const adviceCount = (await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))).length;

    await c.ingestInbound(inbound({ text: 'We bought them last night, thanks for the help!', from: who, subject: 'Re: Rangers', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await drain(h, c, FIXTURE_NOW);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).toBe('closed');
    expect((await outcomes(r.requestId)).map((o) => [o.kind, o.source])).toEqual([['user_reported_purchase', 'customer_reply']]);
    expect(await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId))).toHaveLength(adviceCount); // no new advice
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    // Nothing was being watched, so the closure doesn't say a watch was stopped (TGQA-R6 27).
    expect(sends.some((s) => s.bodyText.includes('Glad you got them. Enjoy it.'))).toBe(true);
    expect(sends.some((s) => /stopped (?:the price watch|keeping an eye)/.test(s.bodyText))).toBe(false);
  });

  it('sends one follow-up the day after the event, reads the answer, and never sends a second', async () => {
    const who = 'followup@customer.example';
    const c = makeConcierge(h, { env: env(who) });
    const first = inbound({ text: 'Two Rangers tickets Oct 3 please, up to $300 total', from: who, subject: 'Rangers' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await drain(h, c, FIXTURE_NOW);

    // The advice went out (tests have no email provider, so it is marked delivered here).
    await h.db.update(t.sendIntents).set({ state: 'delivered' }).where(eq(t.sendIntents.requestId, r.requestId));
    const after = new Date('2026-10-05T15:00:00Z');
    const later = makeConcierge(h, { env: env(who), now: () => after });
    const pass = await later.sendFollowUps();
    expect(pass.queued).toBeGreaterThanOrEqual(1);
    const follow = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))).find((s) => s.messageClass === 'follow_up')!;
    expect(follow.bodyText).toContain('did my note change which tickets you bought, or when you bought them?');
    expect(follow.bodyText).not.toMatch(/https?:\/\/(?!ticketguy)/); // no seller links, no pitch
    expect((await later.sendFollowUps()).queued).toBe(0); // once per request

    await later.ingestInbound(inbound({ text: 'Yes, I waited a day like you said and got them cheaper', from: who, subject: 'Re: Rangers', inReplyTo: first.rfcMessageId, references: first.rfcMessageId, receivedAt: after }));
    await drain(h, later, after);
    const kinds = (await outcomes(r.requestId)).map((o) => o.kind).sort();
    expect(kinds).toEqual(['follow_up_reply', 'follow_up_sent', 'user_reported_purchase']);
    const reply = (await outcomes(r.requestId)).find((o) => o.kind === 'follow_up_reply')!;
    expect(reply.details).toMatchObject({ bought: true, changedWhen: true });
  });

  it('keeps the follow-up off until it is switched on', () => {
    const base = { recipientLookup: 'x@customer.example', approved: false, approvalHashMatches: false, revisionCurrent: true, evidenceFresh: true, containsFixtureData: false, marketingPermission: false };
    const live = { ...testEnv(), APP_MODE: 'live' as const, EMAIL_SEND_ENABLED: true };
    const off = evaluateGate(live, {}, new Set(), { ...base, messageClass: 'follow_up' });
    expect(off.allowed === false && off.reasons).toContain('follow_up_disabled');
    const on = evaluateGate({ ...live, FOLLOW_UP_ENABLED: true }, {}, new Set(), { ...base, messageClass: 'follow_up' });
    expect(on.allowed === false ? on.reasons : []).not.toContain('follow_up_disabled');
    const killed = evaluateGate({ ...live, FOLLOW_UP_ENABLED: true }, { follow_ups: false }, new Set(), { ...base, messageClass: 'follow_up' });
    expect(killed.allowed === false && killed.reasons).toContain('kill_switch_follow_ups');
  });

  it('a reply that brings a new link is a request, not an outcome; "stop watching" stops', async () => {
    const who = 'stop@customer.example';
    const c = makeConcierge(h, { env: env(who) });
    const first = inbound({ text: 'Two Rangers tickets Oct 3 please', from: who, subject: 'Rangers' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await drain(h, c, FIXTURE_NOW);
    await c.ingestInbound(inbound({ text: 'I got these instead? https://www.stubhub.com/new-york-rangers-new-york-tickets-10-3-2026/event/1/?quantity=2', from: who, subject: 'Re: Rangers', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await drain(h, c, FIXTURE_NOW);
    expect(await outcomes(r.requestId)).toHaveLength(0);
    await c.ingestInbound(inbound({ text: 'You can stop watching, plans changed', from: who, subject: 'Re: Rangers', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await drain(h, c, FIXTURE_NOW);
    expect((await outcomes(r.requestId)).map((o) => o.kind)).toEqual(['stop_watching']);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).toBe('closed');
  });
});
