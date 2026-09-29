import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';

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

  it('no subject from the customer: the acknowledgment and the answer share one subject, and both say "Hey Tobias,"', async () => {
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'tobias@customer.example' }) });
    const r = (await c.ingestInbound(inbound({ text: 'Hey hey, Tobias here. Two Rangers tickets Oct 3, $300 total. Should I buy now?', from: 'tobias@customer.example', subject: null }))) as { requestId: string };
    await drain(c);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(sends.length).toBeGreaterThanOrEqual(2);
    const base = (s: string) => s.replace(/^re:\s*/i, '');
    expect(new Set(sends.map((s) => base(s.subject))).size).toBe(1);
    for (const s of sends) expect(s.bodyText.startsWith('Hey Tobias,')).toBe(true);
    const [contact] = await h.db.select().from(t.contacts).where(eq(t.contacts.emailLookup, 'tobias@customer.example'));
    expect(contact!.firstName).toBe('Tobias');
  });

  it('with a subject, every reply is "Re:" that subject; the account name greets when nothing is said', async () => {
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'priya@customer.example' }) });
    const r = (await c.ingestInbound(inbound({ text: 'Two Rangers tickets Oct 3, $300 total.', from: 'priya@customer.example', fromName: 'Priya Patel', subject: 'Rangers' }))) as { requestId: string };
    await drain(c);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(sends.length).toBeGreaterThanOrEqual(2);
    for (const s of sends) {
      expect(s.subject).toBe('Re: Rangers');
      expect(s.bodyText.startsWith('Hey Priya,')).toBe(true);
    }
  });
});
