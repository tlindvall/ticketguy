import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { normalizeMessageId, normalizeReferencesHeader } from '@/lib/intake/threading';

/**
 * A request sent without a subject got two emails with different subjects, which Gmail showed as two threads;
 * and "Tobias here" still got "Hey,". Every email in a conversation now carries one subject, and greets by name.
 */
describe('one thread, and the customer by name', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  const drain = async (c: ReturnType<typeof makeConcierge>) => {
    for (let i = 0; i < 10; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
      if (!leased.length) return;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
  };

  it('no subject from the customer: every reply shares one subject, and each says "Hey Tobias,"', async () => {
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'tobias@customer.example' }) });
    const r = (await c.ingestInbound(inbound({ text: 'Hey hey, Tobias here. Two Rangers tickets Oct 3, $300 total. Should I buy now?', from: 'tobias@customer.example', subject: null }))) as { requestId: string };
    await drain(c);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    // Under auto-approve the answer is the first reply; no separate acknowledgment (TGQA-R8 writing review).
    expect(sends.length).toBeGreaterThanOrEqual(1);
    // Gmail threads a reply only when its subject matches the thread's: a subject of our own ("A couple of
    // quick questions") opened a second thread beside the customer's subjectless one. Every reply is "Re:".
    for (const s of sends) {
      expect(s.subject).toBe('Re:');
      expect(s.headers['In-Reply-To']).toMatch(/^<[^<>\s]+>$/);
    }
    for (const s of sends) expect(s.bodyText.startsWith('Hey Tobias,')).toBe(true);
    const [contact] = await h.db.select().from(t.contacts).where(eq(t.contacts.emailLookup, 'tobias@customer.example'));
    expect(contact!.firstName).toBe('Tobias');
  });

  it('with a subject, every reply is "Re:" that subject; the account name greets when nothing is said', async () => {
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'priya@customer.example' }) });
    const r = (await c.ingestInbound(inbound({ text: 'Two Rangers tickets Oct 3, $300 total.', from: 'priya@customer.example', fromName: 'Priya Patel', subject: 'Rangers' }))) as { requestId: string };
    await drain(c);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    // Under auto-approve the answer is the first reply; no separate acknowledgment (TGQA-R8 writing review).
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const s of sends) {
      expect(s.subject).toBe('Re: Rangers');
      expect(s.bodyText.startsWith('Hey Priya,')).toBe(true);
    }
  });

  it('a bare Message-ID from the provider is bracketed, so replies thread and the reply to our reply is found', async () => {
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'bare@customer.example' }) });
    const first = inbound({ text: 'Two Rangers tickets Oct 3, $300 total.', from: 'bare@customer.example', subject: 'Rangers', rfcMessageId: normalizeMessageId('CAbare-1@mail.gmail.com') });
    expect(first.rfcMessageId).toBe('<CAbare-1@mail.gmail.com>');
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await drain(c);
    const [send] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(send!.headers['In-Reply-To']).toBe('<CAbare-1@mail.gmail.com>');
    // Their reply names the original only by a bare ID; it still lands in the same conversation.
    const reply = await c.ingestInbound(inbound({ text: 'Make it 4', from: 'bare@customer.example', subject: 'Re: Rangers', inReplyTo: normalizeReferencesHeader('CAbare-1@mail.gmail.com'), references: normalizeReferencesHeader('CAbare-1@mail.gmail.com') }));
    expect((reply as { requestId: string }).requestId).toBe(r.requestId);
  });
});

describe('Message-ID normalisation', () => {
  it('brackets bare IDs and leaves bracketed ones alone', () => {
    expect(normalizeMessageId('abc@mail.gmail.com')).toBe('<abc@mail.gmail.com>');
    expect(normalizeMessageId(' <abc@mail.gmail.com> ')).toBe('<abc@mail.gmail.com>');
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeReferencesHeader('a@x.com <b@y.com>\r\n c@z.com')).toBe('<a@x.com> <b@y.com> <c@z.com>');
  });
});
