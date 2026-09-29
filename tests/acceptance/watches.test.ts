import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';

/** A price watch exists only when some seller may be checked on a schedule; otherwise it could never alert. */
describe('price watches', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  const ask = async (from: string) => {
    const c = makeConcierge(h);
    const r = await c.ingestInbound(inbound({ text: 'Rangers Oct 3, 5 tickets, $450 total. Let me know if it drops.', from, subject: 'Rangers' }));
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
    const requestId = (r as { requestId: string }).requestId;
    return h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId));
  };

  it('is created when a seller with monitoring rights is enabled', async () => {
    expect(await ask('watch-yes@customer.example')).toHaveLength(1);
  });

  it('is not created when no seller may be monitored', async () => {
    await h.db.update(t.adapterConfigs).set({ monitoringAllowed: false });
    expect(await ask('watch-no@customer.example')).toHaveLength(0);
    const [a] = await h.db.select().from(t.auditLog).where(eq(t.auditLog.action, 'watch.not_created'));
    expect(a).toBeDefined();
  });
});
