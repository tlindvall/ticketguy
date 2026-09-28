import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { REGRESSION_CASES } from '../regression/cases';

/** Every regression case through the real pipeline (rules extractor, fixture world), one customer each. */
describe('regression set: real-sounding requests', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  const interpretAll = async (c: ReturnType<typeof makeConcierge>) => {
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

  for (const [i, rc] of REGRESSION_CASES.entries()) {
    it(`${rc.id}: "${rc.text.replace(/\s+/g, ' ').slice(0, 70)}"`, async () => {
      const c = makeConcierge(h);
      const r = await c.ingestInbound(inbound({ text: rc.text, from: `case${i}@customer.example`, subject: `Case ${rc.id}` }));
      await interpretAll(c);
      const requestId = (r as { requestId: string }).requestId;
      const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
      if (rc.brief) {
        const [v] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId)).orderBy(desc(t.requestVersions.revision)).limit(1);
        expect(v?.brief, 'stored brief').toMatchObject(rc.brief);
      }
      if (rc.reply) {
        if (rc.reply.state) expect(req!.state).toBe(rc.reply.state);
        const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId));
        if (rc.reply.sends === false) expect(sends).toHaveLength(0);
        const body = sends.map((s) => s.bodyText).join('\n---\n');
        for (const s of rc.reply.contains ?? []) expect(body, `reply should contain: ${s}`).toContain(s);
        for (const s of rc.reply.notContains ?? []) expect(body, `reply should not contain: ${s}`).not.toContain(s);
      }
    });
  }

  it('has fifty cases, every request type, and unique ids', () => {
    expect(REGRESSION_CASES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(REGRESSION_CASES.map((c) => c.id)).size).toBe(REGRESSION_CASES.length);
    for (const type of ['find', 'browse', 'watch', 'stop'] as const) expect(REGRESSION_CASES.some((c) => c.type === type), type).toBe(true);
  });
});
