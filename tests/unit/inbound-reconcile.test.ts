import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { inbound, makeConcierge, openTestDb } from '../harness';
import { listReceivedEmails, reconcileReceived, ReceivedListError } from '@/lib/email/reconcile';

/**
 * The webhook once lost its `email.received` subscription for twenty hours and five customer emails sat at
 * the provider with nothing pointing at them. The sweep compares the provider's list with what arrived and
 * queues the difference through the ordinary retrieval path. It must be idempotent, must never double up a
 * message the webhook did deliver, and must refuse to read a list it does not recognise.
 */
function fakeFetch(handler: (url: string) => { status: number; body: unknown }): typeof fetch {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const r = handler(url);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  (f as unknown as { calls: string[] }).calls = calls;
  return f;
}

const listing = (ids: string[]) => ({ object: 'list', has_more: false, data: ids.map((id) => ({ object: 'email', id, created_at: '2026-09-24T10:00:00.000Z' })) });

describe('inbound reconciliation', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('parses the documented envelope and a bare array, and reads only ids and timestamps', async () => {
    const a = await listReceivedEmails('key', { fetchImpl: fakeFetch(() => ({ status: 200, body: listing(['e1', 'e2']) })) });
    expect(a).toEqual([
      { id: 'e1', createdAt: '2026-09-24T10:00:00.000Z' },
      { id: 'e2', createdAt: '2026-09-24T10:00:00.000Z' },
    ]);
    const b = await listReceivedEmails('key', { fetchImpl: fakeFetch(() => ({ status: 200, body: [{ email_id: 'e3', received_at: '2026-09-24T11:00:00.000Z', subject: 'never read' }] })) });
    expect(b).toEqual([{ id: 'e3', createdAt: '2026-09-24T11:00:00.000Z' }]);
  });

  it('refuses a list it does not recognise instead of reporting nothing missing', async () => {
    await expect(listReceivedEmails('key', { fetchImpl: fakeFetch(() => ({ status: 200, body: { emails: [{ id: 'x' }] } })) })).rejects.toMatchObject({ kind: 'unrecognized', message: 'resend_receive_list_unrecognized:envelope_keys=emails' });
    await expect(listReceivedEmails('key', { fetchImpl: fakeFetch(() => ({ status: 200, body: { data: [{ uuid: 'x' }] } })) })).rejects.toBeInstanceOf(ReceivedListError);
    await expect(listReceivedEmails('key', { fetchImpl: fakeFetch(() => ({ status: 401, body: { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' } })) })).rejects.toMatchObject({ kind: 'http', message: 'resend_receive_list_failed:401:restricted_api_key: This API key is restricted to only send emails' });
  });

  it('clamps the requested page size to what the provider allows', async () => {
    const f = fakeFetch(() => ({ status: 200, body: listing([]) }));
    await listReceivedEmails('key', { limit: 500, fetchImpl: f });
    expect((f as unknown as { calls: string[] }).calls[0]).toContain('limit=100');
  });

  it('dry run reports what the webhook never delivered and writes nothing; apply queues exactly that, once', async () => {
    // e-known arrived through the webhook; e-lost never did.
    await h.db.insert(t.inboundEvents).values({ provider: 'resend', providerEventId: 'msg_svix_1', eventType: 'email.received', payloadHash: 'h', payload: { type: 'email.received', data: { email_id: 'e-known' } }, signatureVerified: true });
    const f = fakeFetch(() => ({ status: 200, body: listing(['e-known', 'e-lost']) }));

    const dry = await reconcileReceived(h.db, { apiKey: 'key', apply: false, fetchImpl: f });
    expect(dry).toEqual({ listed: 2, known: 1, missing: ['e-lost'], enqueued: 0 });
    expect(await h.db.select().from(t.inboundEvents).where(eq(t.inboundEvents.providerEventId, 'reconcile:e-lost'))).toHaveLength(0);

    const applied = await reconcileReceived(h.db, { apiKey: 'key', apply: true, fetchImpl: f, actor: 'test' });
    expect(applied).toMatchObject({ listed: 2, known: 1, missing: ['e-lost'], enqueued: 1 });
    const [ev] = await h.db.select().from(t.inboundEvents).where(eq(t.inboundEvents.providerEventId, 'reconcile:e-lost'));
    expect(ev).toMatchObject({ provider: 'resend', eventType: 'email.received', processingState: 'pending', signatureVerified: false });
    // Shaped so ingestFromProvider takes the retrieval path: metadata only, email_id present, no body.
    expect((ev!.payload as { data: { email_id: string } }).data.email_id).toBe('e-lost');
    const outbox = await h.db.select().from(t.outboxEvents).where(eq(t.outboxEvents.eventKey, 'received:reconcile:e-lost'));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toEqual({ inboundEventId: ev!.id });
    const auditRows = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'inbound.reconciled'), eq(t.auditLog.entityId, ev!.id)));
    expect(auditRows).toHaveLength(1);

    // A second sweep sees the reconciled event as known and queues nothing more.
    const again = await reconcileReceived(h.db, { apiKey: 'key', apply: true, fetchImpl: f });
    expect(again).toEqual({ listed: 2, known: 2, missing: [], enqueued: 0 });
    expect(await h.db.select().from(t.outboxEvents).where(eq(t.outboxEvents.eventKey, 'received:reconcile:e-lost'))).toHaveLength(1);
  });

  it('treats a message already stored from an earlier ingestion as known even when its webhook event is gone', async () => {
    // Ingest through the real pipeline so the stored message is exactly what a reconciled retrieval leaves behind.
    const c = makeConcierge(h);
    const r0 = await c.ingestInbound(inbound({ provider: 'resend', providerEmailId: 'e-stored', text: 'Two tickets to the Rangers on Oct 3 please, $400 total.', from: 'carol@customer.example' }));
    expect(r0.kind).not.toBe('duplicate');
    const r = await reconcileReceived(h.db, { apiKey: 'key', apply: false, fetchImpl: fakeFetch(() => ({ status: 200, body: listing(['e-stored']) })) });
    expect(r).toEqual({ listed: 1, known: 1, missing: [], enqueued: 0 });
  });
});
