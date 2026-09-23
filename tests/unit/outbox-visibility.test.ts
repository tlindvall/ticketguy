import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db';
import { openTestDb } from '../harness';
import { enqueueOutbox, leaseDueOutbox, markFailed, outboxLag, retryingOutbox } from '@/lib/intake/outbox';

/**
 * A row that just failed always has next_attempt_at in the future. Counting only due rows made a
 * repeatedly failing pipeline read as an empty outbox on the operations board.
 */
describe('outbox visibility while retrying', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('counts a backed-off row as pending and lists it with its last error', async () => {
    const now = new Date('2026-09-23T12:00:00Z');
    await enqueueOutbox(h.db, { eventType: 'email.received', eventKey: 'visibility-1', entityId: 'e1', payload: {}, now });
    const [leased] = await leaseDueOutbox(h.db, { limit: 10, now });
    expect(leased).toBeDefined();

    expect(await markFailed(h.db, leased!, 'resend_receive_fetch_failed:401', now)).toBe('retry');

    const lag = await outboxLag(h.db, now);
    expect(lag.pending).toBe(1); // still queued
    expect(lag.due).toBe(0); // but not due yet — this is what used to read as an empty outbox
    expect(lag.dead).toBe(0);

    const retrying = await retryingOutbox(h.db);
    const row = retrying.find((r) => r.eventKey === 'visibility-1');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe('resend_receive_fetch_failed:401');
  });

  it('dead-letters after the attempt budget and stops counting as pending', async () => {
    let now = new Date('2026-09-23T13:00:00Z');
    await enqueueOutbox(h.db, { eventType: 'email.received', eventKey: 'visibility-2', entityId: 'e2', payload: {}, now });
    let outcome: 'retry' | 'dead' = 'retry';
    for (let i = 0; i < 8 && outcome === 'retry'; i += 1) {
      now = new Date(now.getTime() + 3_600_000); // jump past any backoff
      const leased = (await leaseDueOutbox(h.db, { limit: 10, now })).find((l) => l.eventKey === 'visibility-2');
      expect(leased).toBeDefined();
      outcome = await markFailed(h.db, leased!, 'boom', now);
    }
    expect(outcome).toBe('dead');
    const lag = await outboxLag(h.db, now);
    expect(lag.dead).toBe(1);
    expect(retrying(await retryingOutbox(h.db))).not.toContain('visibility-2');
  });
});

const retrying = (rows: Array<{ eventKey: string }>) => rows.map((r) => r.eventKey);
