import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { SERVICE_DOMAIN } from '@/lib/config/brand';

let h: DbHandle;
beforeAll(async () => {
  h = await openTestDb();
});
afterAll(async () => {
  await h.close();
});

async function drain(c: ReturnType<typeof makeConcierge>, now = FIXTURE_NOW) {
  for (let i = 0; i < 10; i++) {
    const leased = await leaseDueOutbox(h.db, { limit: 50, now });
    if (!leased.length) return;
    for (const ev of leased) {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
      else if (ev.eventType === 'email.send_requested') await c.dispatchSend(p.sendIntentId!);
      await markDispatched(h.db, ev.id, ev.leaseToken, now);
    }
  }
}

const PRIMARY = `my@${SERVICE_DOMAIN}`;
const SECONDARY = `support@${SERVICE_DOMAIN}`;
const ALERTS = `alerts@${SERVICE_DOMAIN}`;
const BODY = 'Two of us for the Rangers preseason game at MSG on Oct 3, $300 total.';

describe('multiple service addresses', () => {
  it('accepts mail addressed to a secondary inbound address', async () => {
    const c = makeConcierge(h, { env: testEnv({ CONCIERGE_INBOUND_ADDRESSES: SECONDARY }) });
    const out = await c.ingestInbound(inbound({ from: 'multi-a@customer.example', to: [SECONDARY], text: BODY }));
    expect(out.kind).toBe('queued');
  });

  it('still ignores an address that is not configured', async () => {
    const c = makeConcierge(h, { env: testEnv() });
    const out = await c.ingestInbound(inbound({ from: 'multi-b@customer.example', to: [SECONDARY], text: BODY }));
    expect(out.kind).toBe('ignored_recipient');
  });

  it('applies a per-class From only to that class, and keeps Reply-To on the public address', async () => {
    const env = testEnv({ CONCIERGE_INBOUND_ADDRESSES: ALERTS, MESSAGE_CLASS_FROM_ADDRESSES: `watch_alert=${ALERTS}` });
    const c = makeConcierge(h, { env });
    await c.ingestInbound(inbound({ from: 'multi-c@customer.example', to: [PRIMARY], text: BODY }));
    await drain(c);

    const rows = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.messageClass, 'acknowledgment')))
      .filter((r) => r.recipient === 'multi-c@customer.example');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // acknowledgment carries no override, so remapping watch_alert must not have touched it.
      expect(r.fromAddress).toBe(`Ticket Guy <${PRIMARY}>`);
      expect((r.headers as Record<string, string>)['Reply-To']).toBe(PRIMARY);
    }
  });
});
