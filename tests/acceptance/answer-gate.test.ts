import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, inbound, testEnv, RecordingProvider } from '../harness';
import { Concierge, heldDraftBody } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { bannedLines, feedNameInCaps, type AnswerJudge, type AnswerVerdict } from '@/lib/email/answer-gate';

/**
 * Fix plan Phase 0 (Oct 16): no reply reaches a customer without passing the answer gate. Live on Oct 15 the bot sent "I
 * haven't been able to check this against any seats yet", "Rangers tickets for Monday, October 19. Got it." to "are these
 * good tickets?", and "CBJ V. NEW YORK RANGERS". A reply that fails is held: the customer is told a person has it, staff
 * get the customer's message and the held draft, and send it, edit it or write their own from the request page.
 */
describe('lines we never send', () => {
  it('catches the live Oct 15 lines', () => {
    expect(bannedLines('Hey,\n\nI haven’t been able to check this against any seats yet: $300 in total for both.')).toContain('banned_cannot_check');
    expect(bannedLines('Nothing I can check automatically has shown me seats that meet it.')).toContain('banned_nothing_automatic');
    expect(bannedLines('Hey,\n\nNew York Rangers tickets for Monday, October 19. Got it.')).toContain('banned_got_it');
    expect(bannedLines('The next one is CBJ V. NEW YORK RANGERS at Nationwide Arena in Columbus.')).toContain('banned_caps_feed_name');
    expect(feedNameInCaps('CBJ V. NEW YORK RANGERS at Nationwide Arena')).toBe('CBJ V. NEW YORK RANGERS');
  });

  it('leaves ordinary copy alone: short codes, a single shouted word, our own address', () => {
    expect(bannedLines('Two seats in GA at MSG, VIP entry. Reply CONFIRM to delete your data. Got your follow-up.')).toEqual([]);
    expect(bannedLines('New York Rangers vs. Ottawa Senators at Madison Square Garden. Ticket Guy is for US-based fans.')).toEqual([]);
    expect(bannedLines('Hey,\n\nYour pick.\n\nTICKET GUY INC, 100 MAIN STREET, NEW YORK', ['TICKET GUY INC, 100 MAIN STREET, NEW YORK'])).toEqual([]);
  });
});

class FakeJudge implements AnswerJudge {
  readonly name = 'fake';
  lastUsage = { inputTokens: 900, outputTokens: 40 };
  calls: Array<{ latest: string; reply: string }> = [];
  constructor(public verdict: AnswerVerdict | 'throw') {}
  async judge(input: { latest: string; reply: string }): Promise<AnswerVerdict> {
    this.calls.push(input);
    if (this.verdict === 'throw') throw new Error('provider down');
    return this.verdict;
  }
}

const STAFF = 'staff@ticketguy.test';
// Sent as production sends while testing: drafts go out unreviewed to the testers on the allowlist.
const CUSTOMERS = ['held', 'asis', 'edit', 'judged', 'down', 'fine', 'plain'].map((x) => `${x}@customer.example`);
const env = testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', EXTRACTION_PROVIDER: 'rules', STAFF_EMAIL_ALLOWLIST: STAFF, EMAIL_TEST_RECIPIENT_ALLOWLIST: [...CUSTOMERS, STAFF].join(','), AUTO_APPROVE_WHILE_TESTING: 'true' });

describe('the answer gate before every reply', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  const setup = (judge?: AnswerJudge) => {
    const provider = new RecordingProvider();
    const c = new Concierge({ db: h.db, env, extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: provider, fixtureOffers: {}, answerGate: true, answerJudge: judge });
    const drain = async () => {
      for (let i = 0; i < 12; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
        if (!leased.length) return;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          else if (ev.eventType === 'email.send_requested') await c.dispatchSend(p.sendIntentId!);
          else if (ev.eventType === 'staff.alert') await c.alertStaff({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
        }
      }
    };
    return { c, provider, drain };
  };
  const writeIn = async (c: Concierge, from: string, text: string) => (await c.ingestInbound(inbound({ text, from, subject: 'Rangers' }))) as { requestId: string; conversationId: string; contactId: string };

  it('holds a reply with an internal line: the customer hears a person has it, staff get their words and the draft', async () => {
    const { c, provider, drain } = setup();
    const from = 'held@customer.example';
    const r = await writeIn(c, from, 'Two Rangers tickets Oct 3, $300 total. Should I buy now?');
    await drain();
    const toCustomer = provider.sent.filter((s) => s.to === from);
    // Only the hand-off reached the customer, never the line.
    expect(toCustomer.map((s) => s.text).join('\n')).not.toMatch(/haven[’']t been able to check|Nothing I can check automatically/);
    expect(toCustomer.some((s) => /a manual check|passed it to the team/.test(s.text))).toBe(true);
    const [held] = await h.db.select().from(t.sendIntents).where(and(eq(t.sendIntents.requestId, r.requestId), like(t.sendIntents.dedupeKey, `held:${r.requestId}:%`)));
    expect(held!.state).toBe('blocked');
    expect(held!.lastError).toMatch(/^answer_gate:banned_cannot_check,banned_nothing_automatic/);
    // The code that queued it moved on as if sent; the request stays with the person.
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).toBe('manual_attention');
    // The alert carries what they wrote and what we would have sent.
    const alert = provider.sent.find((s) => s.to === STAFF);
    expect(alert?.subject).toBe('Needs a person: the drafted reply was held before sending');
    expect(alert?.text).toContain('Why it was held: it says we haven’t been able to check; it says nothing can be checked automatically.');
    expect(alert?.text).toContain('The customer wrote:\nTwo Rangers tickets Oct 3, $300 total. Should I buy now?');
    expect(alert?.text).toContain('The held reply:\nHey,');
    const shown = await c.heldReply(r.requestId);
    expect(shown?.id).toBe(held!.id);
  });

  it('sent as drafted: the original email goes out once, as a staff reply, and the request is answered', async () => {
    const { c, provider, drain } = setup();
    const from = 'asis@customer.example';
    const r = await writeIn(c, from, 'Two Rangers tickets Oct 3, $300 total. Should I buy now?');
    await drain();
    const held = (await c.heldReply(r.requestId))!;
    const res = await c.sendStaffReply({ requestId: r.requestId, heldId: held.id, body: heldDraftBody(held.text), staffUserId: 'staff-1' });
    expect(res.ok).toBe(true);
    await drain();
    const last = provider.sent.filter((s) => s.to === from).at(-1)!;
    expect(last.text).toBe(held.text);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.state).toBe('recommendation_sent');
    expect(await c.heldReply(r.requestId)).toBeNull();
    // Answering the same held reply twice is refused rather than sent again.
    expect(await c.sendStaffReply({ requestId: r.requestId, heldId: held.id, body: 'again', staffUserId: 'staff-1' })).toEqual({ ok: false, status: 409, reason: 'held_reply_changed' });
  });

  it('edited: their words go out with the sign-off, and the gate does not check a person', async () => {
    const { c, provider, drain } = setup();
    const from = 'edit@customer.example';
    const r = await writeIn(c, from, 'Two Rangers tickets Oct 3, $300 total. Should I buy now?');
    await drain();
    const held = (await c.heldReply(r.requestId))!;
    const body = 'Hey,\n\nNothing I can see is under $300 for two right now. The closest pair is $318, Section 224. Want me to keep looking?';
    expect((await c.sendStaffReply({ requestId: r.requestId, heldId: held.id, body, staffUserId: 'staff-1' })).ok).toBe(true);
    await drain();
    const last = provider.sent.filter((s) => s.to === from).at(-1)!;
    expect(last.text.startsWith(body)).toBe(true);
    expect(last.text).toContain('human-reviewed');
  });

  it('asks a model whether the reply answers the latest message, and holds it when not', async () => {
    const judge = new FakeJudge({ answers: false, nextStep: true, problem: 'They asked whether these are good tickets; the reply asks how many.' });
    const { c, provider, drain } = setup(judge);
    const from = 'judged@customer.example';
    const r = await writeIn(c, from, 'Are these good tickets? Rangers Oct 3');
    await drain();
    expect(judge.calls.length).toBeGreaterThan(0);
    expect(judge.calls[0]!.latest).toContain('Are these good tickets?');
    const [held] = await h.db.select().from(t.sendIntents).where(and(eq(t.sendIntents.requestId, r.requestId), like(t.sendIntents.dedupeKey, 'held:%')));
    expect(held!.lastError).toBe('answer_gate:not_answered They asked whether these are good tickets; the reply asks how many.');
    expect(provider.sent.find((s) => s.to === STAFF)?.text).toContain('Why it was held: it doesn’t answer the customer’s message. They asked whether these are good tickets; the reply asks how many.');
    // The call's spend is on the request.
    const ledger = await h.db.select().from(t.usageLedger).where(and(eq(t.usageLedger.requestId, r.requestId), eq(t.usageLedger.jobName, 'answer_gate')));
    expect(ledger.length).toBeGreaterThan(0);
  });

  it('a check that cannot run holds the reply rather than sending it unchecked', async () => {
    const { c, drain } = setup(new FakeJudge('throw'));
    const r = await writeIn(c, 'down@customer.example', 'Are these good tickets? Rangers Oct 3');
    await drain();
    const [held] = await h.db.select().from(t.sendIntents).where(and(eq(t.sendIntents.requestId, r.requestId), like(t.sendIntents.dedupeKey, 'held:%')));
    expect(held!.lastError).toBe('answer_gate:check_failed');
  });

  it('a reply that answers goes out as before', async () => {
    const judge = new FakeJudge({ answers: true, nextStep: true, problem: '' });
    const { c, provider, drain } = setup(judge);
    const from = 'fine@customer.example';
    const r = await writeIn(c, from, 'Are these good tickets? Rangers Oct 3');
    await drain();
    const held = await h.db.select().from(t.sendIntents).where(and(eq(t.sendIntents.requestId, r.requestId), like(t.sendIntents.dedupeKey, 'held:%')));
    expect(held).toHaveLength(0);
    expect(provider.sent.filter((s) => s.to === from).length).toBeGreaterThan(0);
    expect(provider.sent.some((s) => s.to === STAFF)).toBe(false);
  });

  it('a person can answer a request waiting on them even with nothing held', async () => {
    const { c, provider, drain } = setup();
    const from = 'plain@customer.example';
    const r = await writeIn(c, from, 'Two Knicks tickets Oct 24, $300 total');
    await drain();
    const res = await c.sendStaffReply({ requestId: r.requestId, heldId: null, body: 'Hey,\n\nThe best pair under $300 is Section 105, Row 8, $284 for both.', staffUserId: 'staff-1' });
    expect(res.ok).toBe(true);
    await drain();
    expect(provider.sent.filter((s) => s.to === from).at(-1)!.text).toContain('Section 105, Row 8, $284 for both.');
  });
});
