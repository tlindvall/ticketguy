import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, inbound } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { mayBeVisiting } from '@/lib/intake/pipeline';

/**
 * Eval issue #171 (only_what_was_asked): the pick, and what they asked about. Listings left out, notes about history we
 * lack, trend talk, the single-seat reference, sources checked and when, a blanket US-only line and invitations to send
 * other seats were extra around it. Each piece comes back when the latest message asks for it.
 */
let h: DbHandle;
beforeAll(async () => {
  h = await openTestDb();
});
afterAll(async () => {
  await h.close();
});

async function body(text: string, from: string): Promise<string> {
  const c = makeConcierge(h);
  const r = (await c.ingestInbound(inbound({ text, from }))) as { requestId: string };
  for (let i = 0; i < 10; i++) {
    const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
    if (!leased.length) break;
    for (const ev of leased) {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
  }
  const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
  return rec!.bodyText;
}

const RANGERS = 'Hi! Five of us want to see the New York Rangers preseason game at MSG on Oct 3. We need to sit together, budget is $450 total.';

describe('only what was asked (#171)', () => {
  it('a plain request gets the pick, without history, trend, single-seat reference, sources or check time', async () => {
    const b = await body(RANGERS, 'plain-171@customer.example');
    expect(b).toContain('$425 total ($85 each)');
    expect(b).not.toMatch(/comparable past events|fallen from|cheapest single seat|Checked: |checked Sep|How this compares|Why your group size matters|outside the US|Found seats you like/);
  });

  it('asked about the trend: the trend is the answer', async () => {
    const b = await body(`${RANGERS} Are prices going down, or should I wait?`, 'trend-171@customer.example');
    expect(b).toMatch(/fallen from \$475 to \$425/);
  });

  it('asked for other options: why the cheaper one was left out comes back', async () => {
    const plain = await body(RANGERS, 'plain2-171@customer.example');
    const asked = await body(`${RANGERS} What other options are there?`, 'others-171@customer.example');
    expect(plain).not.toContain('I left out');
    expect(asked).toContain('I left out a cheaper listing: one has an obstructed view.');
  });

  it('the US-only line is for someone who may be visiting, not everyone', () => {
    expect(mayBeVisiting("I'm in New York for the weekend, 2 Rangers tickets Oct 3")).toBe(true);
    expect(mayBeVisiting('We’re visiting from Toronto next month')).toBe(true);
    expect(mayBeVisiting('Two Rangers tickets Oct 3, my dad is visiting')).toBe(false);
    expect(mayBeVisiting('Two Rangers tickets Oct 3, $300 total')).toBe(false);
  });
});
