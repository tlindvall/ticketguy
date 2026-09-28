import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound, RecordingProvider, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { Concierge, staffReasonLabel, staffedHoursLabel } from '@/lib/intake/pipeline';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { ModelOutputError } from '@/lib/ai/model-client';
import { setKillSwitch } from '@/lib/email/send-gate';
import { FIXTURE_NOW, FIXTURE_OFFERS } from '@/lib/fixtures';

/**
 * A request only a person can move used to go quiet: the fourth unanswered message in a thread, or a message
 * the model could not read, left the customer with no reply and staff with no alert. These pin the reply and
 * the alert.
 */
describe('waiting on a person', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  const env = testEnv({ STAFF_EMAIL_ALLOWLIST: 'tobias@ticketguy.now,ops@ticketguy.now' });

  /** Interpret only, so the queued sends and alerts stay in the outbox to be inspected. */
  const interpretAll = async (c: Concierge) => {
    for (let i = 0; i < 5; i++) {
      const work = (await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW })).filter((ev) => ev.eventType === 'request.interpret');
      if (!work.length) return;
      for (const ev of work) {
        const p = ev.payload as Record<string, string>;
        await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
  };
  const alertsFor = (requestId: string) => h.db.select().from(t.outboxEvents).where(and(eq(t.outboxEvents.eventType, 'staff.alert'), eq(t.outboxEvents.entityId, requestId)));
  const holdingFor = async (requestId: string) => (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).filter((s) => s.bodyText.includes('this one needs a person'));

  it('after three rounds of questions, the customer is told a person has it and staff are alerted', async () => {
    const c = makeConcierge(h, { env });
    const first = inbound({ text: 'Some tickets for the Rangers please', from: 'loop@customer.example' });
    const r = await c.ingestInbound(first);
    await interpretAll(c);
    for (const text of ['Still not sure how many, some tickets', 'A few seats maybe', 'Some tickets, any date']) {
      await c.ingestInbound(inbound({ text, from: 'loop@customer.example', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
      await interpretAll(c);
    }
    const requestId = (r as { requestId: string }).requestId;
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('manual_attention');

    const holding = await holdingFor(requestId);
    expect(holding).toHaveLength(1);
    expect(holding[0]!.bodyText).toContain('Thanks for bearing with me — this one needs a person, so I’ve passed it to the team.');
    expect(holding[0]!.bodyText).toContain('The team replies between 9am–9pm ET.');
    expect(holding[0]!.bodyText).toContain('AI-assisted ticket advice.');
    expect(await alertsFor(requestId)).toHaveLength(1);

    // Another message on the same stuck request: a new revision alerts staff again, the customer is not re-told.
    await c.ingestInbound(inbound({ text: 'Hello? Some tickets please', from: 'loop@customer.example', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
    await interpretAll(c);
    expect(await holdingFor(requestId)).toHaveLength(1);
    expect((await alertsFor(requestId)).length).toBe(2);
  });

  it('a message the model cannot read gets the same reply and alert', async () => {
    const failing = { name: 'failing', extract: async () => { throw new ModelOutputError('malformed', 'response did not satisfy the schema'); } };
    const c = new Concierge({ db: h.db, env, extractor: failing, drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: null, fixtureOffers: FIXTURE_OFFERS });
    const r = await c.ingestInbound(inbound({ text: 'Two Knicks tickets Oct 24', from: 'unreadable@customer.example' }));
    await interpretAll(c);
    const requestId = (r as { requestId: string }).requestId;
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('manual_attention');
    expect(await holdingFor(requestId)).toHaveLength(1);
    expect(await alertsFor(requestId)).toHaveLength(1);
  });

  it('the alert names the reason and links the request, and never carries the customer’s words', async () => {
    const provider = new RecordingProvider();
    const c = makeConcierge(h, { env, provider });
    const first = inbound({ text: 'Some tickets for my surprise party at 42 Wallaby Way', from: 'private@customer.example' });
    const r = await c.ingestInbound(first);
    await interpretAll(c);
    for (const text of ['some tickets', 'some seats', 'a few tickets']) {
      await c.ingestInbound(inbound({ text, from: 'private@customer.example', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
      await interpretAll(c);
    }
    const requestId = (r as { requestId: string }).requestId;
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('manual_attention');
    const out = await c.alertStaff({ requestId, revision: req!.currentRevision });
    expect(out).toEqual({ outcome: 'sent' });
    expect(provider.sent.map((s) => s.to).sort()).toEqual(['ops@ticketguy.now', 'tobias@ticketguy.now']);
    const alert = provider.sent[0]!;
    expect(alert.subject).toBe('Needs a person: three rounds of questions did not settle the request');
    expect(alert.text).toContain(`/admin/requests/${requestId}`);
    expect(alert.text).not.toContain('Wallaby');
    expect(alert.idempotencyKey).toBe(`staff-alert:${requestId}:${req!.currentRevision}:${alert.to}`);
  });

  it('stays quiet when there is nobody to tell, sending is off, everything is stopped, or someone already picked it up', async () => {
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.state, 'manual_attention')).limit(1);
    const args = { requestId: req!.id, revision: req!.currentRevision };
    expect(await makeConcierge(h, { env: testEnv(), provider: new RecordingProvider() }).alertStaff(args)).toEqual({ outcome: 'skipped', reason: 'no_staff_addresses' });
    expect(await makeConcierge(h, { env }).alertStaff(args)).toEqual({ outcome: 'skipped', reason: 'sending_disabled' });
    await setKillSwitch(h.db, 'all_outbound', false, 'test', null);
    expect(await makeConcierge(h, { env, provider: new RecordingProvider() }).alertStaff(args)).toEqual({ outcome: 'skipped', reason: 'kill_switch_all_outbound' });
    await setKillSwitch(h.db, 'all_outbound', true, 'test', null);
    await h.db.update(t.requests).set({ state: 'researching' }).where(eq(t.requests.id, req!.id));
    expect(await makeConcierge(h, { env, provider: new RecordingProvider() }).alertStaff(args)).toEqual({ outcome: 'skipped', reason: 'no_longer_waiting' });
  });

  it('labels reasons and hours in words', () => {
    expect(staffReasonLabel('extraction_failed:malformed: response did not satisfy the schema')).toBe('the AI could not read the message (malformed)');
    expect(staffReasonLabel('extraction_failed:budget_exceeded: cap')).toBe('the AI budget for this request ran out');
    expect(staffedHoursLabel({ STAFFED_HOURS_START: 9, STAFFED_HOURS_END: 21, STAFFED_HOURS_TIMEZONE: 'America/New_York' })).toBe('9am–9pm ET');
  });
});
