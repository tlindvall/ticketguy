import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { AUTO_APPROVER, autoApproveActive } from '@/lib/intake/pipeline';

/**
 * During testing (the recipient allowlist is in force) the owner turned the review step off: a draft is
 * approved by the system as soon as it is written. The approval itself is unchanged, the email says it was
 * not reviewed, and emptying the allowlist brings review back.
 */
describe('auto-approval while testing', () => {
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
  const TEXT = 'Two Rangers tickets Oct 3, $300 total. Should I buy now?';

  it('is on only while the allowlist is in force, and can be turned off', () => {
    expect(autoApproveActive(testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'a@customer.example' }))).toBe(true);
    expect(autoApproveActive(testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: '' }))).toBe(false);
    expect(autoApproveActive(testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'a@customer.example', AUTO_APPROVE_WHILE_TESTING: 'false' }))).toBe(false);
  });

  it('a draft is approved by the system when written, and the email says it was not reviewed', async () => {
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'auto@customer.example' }) });
    const r = (await c.ingestInbound(inbound({ text: TEXT, from: 'auto@customer.example', subject: 'Rangers' }))) as { requestId: string };
    await drain(c);
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    expect(rec).toMatchObject({ reviewStatus: 'approved', reviewerUserId: AUTO_APPROVER });
    expect(rec!.bodyText).not.toContain('human-reviewed');
    const [intent] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.approvalId, rec!.id));
    expect(intent!.approvedHash).toBe(rec!.draftHash);
    expect(intent!.bodyText).toContain('AI-assisted ticket advice.');
    expect(intent!.bodyText).not.toContain('human-reviewed');
    // The gate still has the last word: this fixture draft is not sendable as real mail.
    expect(intent!.headers['X-TicketGuy-Fixture']).toBe('true');
  });

  it('with no allowlist (launched), drafts wait for a person as before', async () => {
    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: '' }) });
    const r = (await c.ingestInbound(inbound({ text: TEXT, from: 'review@customer.example', subject: 'Rangers' }))) as { requestId: string };
    await drain(c);
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    expect(rec!.reviewStatus).toBe('pending');
    // Approved by a person, it goes out saying so.
    const ok = await c.approveRecommendation({ recommendationId: rec!.id, reviewerUserId: 'staff-1', expectedRevision: 1, draftHash: rec!.draftHash, note: null });
    expect(ok.ok).toBe(true);
    const [intent] = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.approvalId, rec!.id));
    expect(intent!.bodyText).toContain('AI-assisted and human-reviewed');
  });
});
