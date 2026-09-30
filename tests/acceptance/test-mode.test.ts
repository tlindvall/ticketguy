import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, inbound, testEnv, RecordingProvider } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { setKillSwitch } from '@/lib/email/send-gate';
import { buildTestInbound, TEST_MODE_KEY, TEST_PROVIDER } from '@/lib/email/test-mode';

/**
 * Test mode (DECISION_LOG #57): everything runs as live and the email is recorded instead of sent. Test customers
 * write in without real mail (Resend counts received mail against the quota too), threaded as a mail client would.
 */
const TESTER = 'owner@customer.example';
const env = testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', EXTRACTION_PROVIDER: 'rules', EMAIL_TEST_RECIPIENT_ALLOWLIST: TESTER, STAFF_EMAIL_ALLOWLIST: 'staff@ticketguy.test' });
const TEXT = 'Two Rangers tickets Oct 3, $300 total. Should I buy now?';

describe('test mode', () => {
  let h: DbHandle;
  let provider: RecordingProvider;
  let c: Concierge;
  beforeAll(async () => {
    h = await openTestDb();
    provider = new RecordingProvider();
    // Live mode, no synthetic offers: the replies are sendable, so what stops them is test mode alone.
    c = new Concierge({ db: h.db, env, extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: provider, fixtureOffers: {} });
  });
  afterAll(async () => {
    await h.close();
  });
  const testMode = (on: boolean) => setKillSwitch(h.db, TEST_MODE_KEY, on, 'staff-1', on ? 'test mode on' : 'test mode off');
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
  const writeIn = async (input: Parameters<typeof buildTestInbound>[2]) => {
    const built = await buildTestInbound(h.db, env, input, FIXTURE_NOW);
    if (!built.ok) throw new Error(built.error);
    return c.ingestInbound(built.message);
  };

  it('refuses a test customer while test mode is off', async () => {
    await testMode(false);
    expect(await buildTestInbound(h.db, env, { from: 'nobody@example.com', text: TEXT }, FIXTURE_NOW)).toEqual({ ok: false, error: 'test_mode_off' });
  });

  it('runs the whole request as live and records every reply instead of sending it', async () => {
    await testMode(true);
    const before = provider.sent.length;
    // Not on the tester allowlist: a recorded send reaches nobody, so any address can be a test customer.
    const r = await writeIn({ from: 'alex+s1@example.com', fromName: 'Alex Rivera', subject: 'Rangers', text: TEXT });
    expect(r.kind).toBe('queued');
    const { requestId, conversationId } = r as { requestId: string; conversationId: string };
    await drain();
    expect(provider.sent.length).toBe(before);
    const intents = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));
    expect(intents.length).toBeGreaterThanOrEqual(1);
    for (const i of intents) expect([i.state, i.lastError]).toEqual(['provider_accepted', null]);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('recommendation_sent');
    const out = await h.db.select().from(t.messages).where(and(eq(t.messages.conversationId, conversationId), eq(t.messages.direction, 'outbound')));
    expect(out).toHaveLength(intents.length);
    for (const m of out) {
      expect(m.provider).toBe(TEST_PROVIDER);
      expect(m.rfcMessageId).toMatch(/^<out-[0-9a-f-]+@test-mode\.invalid>$/);
    }
    const audits = await h.db.select().from(t.auditLog).where(eq(t.auditLog.action, 'send.captured_test_mode'));
    expect(audits.length).toBeGreaterThanOrEqual(intents.length);
  });

  it('a reply threads on our latest email, quoted the way Gmail quotes it, and the quote is stripped on the way in', async () => {
    await testMode(true);
    const first = (await writeIn({ from: 'alex+s2@example.com', subject: 'Rangers', text: TEXT })) as { requestId: string; conversationId: string };
    await drain();
    const built = await buildTestInbound(h.db, env, { replyToRequestId: first.requestId, text: 'Actually make it three of us.' }, FIXTURE_NOW);
    if (!built.ok) throw new Error(built.error);
    expect(built.message.from).toBe('alex+s2@example.com');
    expect(built.message.subject).toMatch(/^Re: /);
    expect(built.message.inReplyTo).toMatch(/^<out-/);
    expect(built.message.references).toContain(built.message.inReplyTo!);
    expect(built.message.text).toMatch(/\n\nOn \w{3}, \w{3} \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M Ticket Guy <[^>]+> wrote:\n\n> /);
    const reply = (await c.ingestInbound(built.message)) as { conversationId: string; isNewConversation: boolean; messageId: string };
    expect(reply.conversationId).toBe(first.conversationId);
    expect(reply.isNewConversation).toBe(false);
    const [stored] = await h.db.select().from(t.messages).where(eq(t.messages.id, reply.messageId));
    expect(stored!.sanitizedText).toBe('Actually make it three of us.');
    expect(stored!.provider).toBe(TEST_PROVIDER);
  });

  it('a test thread stays test-only after test mode is turned off', async () => {
    await testMode(true);
    const first = (await writeIn({ from: 'alex+s3@example.com', subject: 'Rangers', text: TEXT })) as { requestId: string };
    await drain();
    await writeIn({ replyToRequestId: first.requestId, text: 'What about Oct 5 instead?' });
    await testMode(false);
    const before = provider.sent.length;
    await drain();
    expect(provider.sent.length).toBe(before);
    const intents = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, first.requestId));
    expect(intents.every((i) => i.state === 'provider_accepted' && i.providerMessageId?.startsWith('test_'))).toBe(true);
  });

  it('real mail is recorded, not sent, while test mode is on, and sent again once it is off', async () => {
    await testMode(true);
    const before = provider.sent.length;
    await c.ingestInbound(inbound({ text: TEXT, from: TESTER, subject: 'Rangers' }));
    await drain();
    expect(provider.sent.length).toBe(before);

    await testMode(false);
    await c.ingestInbound(inbound({ text: 'Two Rangers tickets Oct 3, $280 total, together please.', from: TESTER, subject: 'Rangers again' }));
    await drain();
    expect(provider.sent.length).toBeGreaterThan(before);
    expect(provider.sent.every((s) => s.to === TESTER)).toBe(true);
  });

  it('test customers are served by the staffed comparison pilot but never use up its places', async () => {
    const OWNER = 'staff@ticketguy.test';
    const pilotEnv = testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', EXTRACTION_PROVIDER: 'rules', EMAIL_TEST_RECIPIENT_ALLOWLIST: 'real@customer.example', STAFF_EMAIL_ALLOWLIST: OWNER, STAFF_COMPARISON_OWNER: OWNER, STAFF_COMPARISON_LIMIT: '1' });
    const pc = new Concierge({ db: h.db, env: pilotEnv, extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: provider, fixtureOffers: {} });
    const ASK = 'Rangers Oct 3, 3 tickets together, $450 total including fees. What is the best suitable option?';
    const offered = async (requestId: string) => (await h.db.select().from(t.requestOutcomes).where(and(eq(t.requestOutcomes.requestId, requestId), eq(t.requestOutcomes.kind, 'staff_comparison_offered'))))[0]?.details as { counted?: boolean } | undefined;
    const run = async (ingest: () => Promise<unknown>) => {
      const r = (await ingest()) as { requestId: string };
      for (let i = 0; i < 12; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await pc.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await pc.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          else if (ev.eventType === 'email.send_requested') await pc.dispatchSend(p.sendIntentId!);
          await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
        }
      }
      return r.requestId;
    };
    await testMode(true);
    for (const who of ['pilot+t1@example.com', 'pilot+t2@example.com']) {
      const id = await run(async () => {
        const built = await buildTestInbound(h.db, pilotEnv, { from: who, subject: 'Rangers for three', text: ASK }, FIXTURE_NOW);
        if (!built.ok) throw new Error(built.error);
        return pc.ingestInbound(built.message);
      });
      expect(await offered(id)).toMatchObject({ counted: false });
    }
    // The one place is still there for a real customer.
    await testMode(false);
    const real = await run(() => pc.ingestInbound(inbound({ text: ASK, from: 'real@customer.example', subject: 'Rangers for three' })));
    expect(await offered(real)).toMatchObject({ counted: true });
  });

  it('skips staff alert emails while test mode is on', async () => {
    await testMode(true);
    expect(await c.alertStaff({ requestId: randomUUID(), revision: 1 })).toEqual({ outcome: 'skipped', reason: 'test_mode' });
    await testMode(false);
    expect(await c.alertStaff({ requestId: randomUUID(), revision: 1 })).toEqual({ outcome: 'skipped', reason: 'request_not_found' });
  });
});
