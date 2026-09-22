import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { openDatabase, type DbHandle } from '@/lib/db';
import { applyMigrations } from '@/lib/db/migrate';
import { seedRegistry } from '@/lib/db/seed';
import { enqueueOutbox, leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { claimSendIntent, createSendIntent } from '@/lib/email/send-intents';
import { reserveBudget, BudgetExceededError } from '@/lib/ai/budget';
import * as t from '@/lib/db/schema';

/**
 * Real PostgreSQL integration checks (A42/A43/A46-adjacent). Requires TEST_DATABASE_URL pointing at a
 * disposable PostgreSQL database; the suite skips itself otherwise. PGlite results cannot satisfy these.
 */
const url = process.env.TEST_DATABASE_URL;
const describeIf = url ? describe : describe.skip;

describeIf('real PostgreSQL', () => {
  const handles: DbHandle[] = [];
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    (process.env as Record<string, string>).NODE_ENV = 'test';
    admin = postgres(url!, { max: 1 });
    await admin`drop schema public cascade`;
    await admin`drop schema if exists drizzle cascade`;
    await admin`create schema public`;
    const h = await openDatabase({ databaseUrl: url });
    await applyMigrations(h);
    await seedRegistry(h.db);
    handles.push(h);
  }, 120_000);
  afterAll(async () => {
    for (const h of handles) await h.close();
    await admin.end();
  });

  it('A42: the committed migration history applies on PostgreSQL (auth + bytea media tables present)', async () => {
    const h = handles[0]!;
    const r = await h.db.execute<{ n: number }>(sql`select count(*)::int as n from information_schema.tables where table_schema='public' and table_name in ('user','session','two_factor','media_objects','outbox_events','send_intents')`);
    const rows = (Array.isArray(r) ? r : (r as unknown as { rows: Array<{ n: number }> }).rows) as Array<{ n: number }>;
    expect(Number(rows[0]!.n)).toBe(6);
  });

  it('A43: concurrent workers on separate connections lease each outbox row exactly once', async () => {
    const h = handles[0]!;
    const now = new Date();
    for (let i = 0; i < 40; i++) await h.db.transaction((tx) => enqueueOutbox(tx, { eventType: 'retention.due', eventKey: `pg-conc-${i}`, entityId: 'x', payload: { i }, now }));
    const workers = await Promise.all([1, 2, 3, 4].map(() => openDatabase({ databaseUrl: url })));
    handles.push(...workers);
    const results = await Promise.all(workers.map((w) => Promise.all([leaseDueOutbox(w.db, { limit: 7, now }), leaseDueOutbox(w.db, { limit: 7, now })])));
    const leased = results.flat(2).filter((e) => e.eventKey.startsWith('pg-conc-'));
    const keys = leased.map((e) => e.eventKey);
    expect(new Set(keys).size).toBe(keys.length); // no double lease across 8 concurrent claims
    expect(keys.length).toBe(40);
    // Dispatch with the right token only.
    for (const ev of leased) expect(await markDispatched(h.db, ev.id, ev.leaseToken, new Date())).toBe(true);
    const again = await leaseDueOutbox(h.db, { limit: 100, now: new Date() });
    expect(again.filter((e) => e.eventKey.startsWith('pg-conc-'))).toHaveLength(0);
  });

  it('A17: a send intent can be claimed by exactly one of many concurrent workers', async () => {
    const h = handles[0]!;
    const [contact] = await h.db.insert(t.contacts).values({ emailOriginal: 'pg@customer.example', emailLookup: 'pg@customer.example' }).returning();
    const { id } = await createSendIntent(h.db, { dedupeKey: 'pg-claim-1', messageClass: 'acknowledgment', contactId: contact!.id, conversationId: null, requestId: null, requestRevision: null, approvalId: null, approvedHash: null, recipient: 'pg@customer.example', fromAddress: 'my@ticketguy.live', subject: 's', bodyText: 'b', bodyHtml: 'b', headers: {} });
    const workers = handles.slice(1);
    const claims = await Promise.all([...workers, ...workers].map((w) => claimSendIntent(w.db, id, new Date())));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('A34: concurrent budget reservations serialize on the advisory lock and cannot overshoot the hard cap', async () => {
    const workers = handles.slice(1);
    const limits = { requestSoftUsd: 0.5, requestHardUsd: 1.0, globalDailyUsd: 100, maxCallsPerRevision: 50 };
    const reqId = '99999999-0000-4000-8000-00000000c0de';
    const attempts = await Promise.allSettled([...workers, ...workers, ...workers].map((w) => reserveBudget(w.db, { requestId: reqId, revision: 1, runId: null, jobName: 'x', model: 'gpt-5.4-mini', estimatedUsdMicros: 300_000, limits, now: new Date() })));
    const ok = attempts.filter((a) => a.status === 'fulfilled').length;
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(ok).toBe(3); // 3 × $0.30 = $0.90 ≤ $1.00; the 4th would exceed
    expect(rejected.length).toBe(attempts.length - 3);
    expect(rejected.every((r) => (r as PromiseRejectedResult).reason instanceof BudgetExceededError)).toBe(true);
  });

  it('A46-adjacent: a least-privilege runtime role cannot alter schema', async () => {
    await admin`drop role if exists tg_runtime_test`;
    await admin`create role tg_runtime_test login password 'x'`;
    await admin`grant usage on schema public to tg_runtime_test`;
    await admin`grant select, insert, update, delete on all tables in schema public to tg_runtime_test`;
    const u = new URL(url!);
    const runtime = postgres(`postgres://tg_runtime_test:x@${u.host}${u.pathname}`, { max: 1 });
    await expect(runtime`create table should_fail (id int)`).rejects.toThrow();
    await expect(runtime`alter table contacts add column nope text`).rejects.toThrow();
    await runtime.end();
  });
});
