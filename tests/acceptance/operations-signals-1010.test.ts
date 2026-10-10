import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, makeConcierge, RecordingProvider, testEnv } from '../harness';
import { deployedCommit, schedulerLiveness } from '@/lib/admin/liveness';
import { resetEnvForTests } from '@/lib/config/env';

// The operations page is staff-only: the guard is the one thing this test stands in for.
vi.mock('@/lib/admin/guard', () => ({ guardPage: async () => ({ id: 'staff-1', email: 'staff@ticketguy.now', role: 'staff' }) }));
// Client components that need a mounted app router; the page's own text is what is checked.
vi.mock('@/components/JsonForm', () => ({ JsonForm: () => null }));
vi.mock('@/components/ActionButton', () => ({ ActionButton: () => null }));

/**
 * Operations signals from the CTO audit of 2026-10-10: gap 26 (no liveness signal for the only scheduler, no visible
 * deployed commit) and gap 18 in part (a dead-lettered email.received row was "not customer work" and reached no one).
 */
const g = globalThis as unknown as { __tgDbHandle?: Promise<DbHandle> };

describe('scheduler liveness and the deployed commit (audit gap 26)', () => {
  let h: DbHandle;
  const saved = { render: process.env.RENDER_GIT_COMMIT, git: process.env.GIT_COMMIT };
  beforeAll(async () => {
    h = await openTestDb();
    // The routes read the process-wide handle: this test's database stands in for it.
    g.__tgDbHandle = Promise.resolve(h);
    resetEnvForTests();
  });
  afterAll(async () => {
    g.__tgDbHandle = undefined;
    process.env.RENDER_GIT_COMMIT = saved.render;
    process.env.GIT_COMMIT = saved.git;
    if (saved.render === undefined) delete process.env.RENDER_GIT_COMMIT;
    if (saved.git === undefined) delete process.env.GIT_COMMIT;
    resetEnvForTests();
    await h.close();
  });

  const row = (key: string, over: Partial<typeof t.outboxEvents.$inferInsert>) => h.db.insert(t.outboxEvents).values({ eventType: 'request.interpret', eventKey: key, entityId: key, payload: {}, ...over });

  it('lag is how long the oldest due row has waited; backoff is not lag; the last dispatch is the newest finished row', async () => {
    const now = new Date('2026-10-10T12:00:00Z');
    expect(await schedulerLiveness(h.db, now)).toEqual({ outboxLagSeconds: 0, lastDispatchAt: null });
    // Written an hour ago but in retry backoff until a minute from now: not the dispatcher's lag.
    await row('lag-backoff', { state: 'pending', createdAt: new Date(now.getTime() - 3_600_000), nextAttemptAt: new Date(now.getTime() + 60_000) });
    expect((await schedulerLiveness(h.db, now)).outboxLagSeconds).toBe(0);
    // Due five minutes ago and not picked up; a lease that expired four minutes ago is due again too.
    await row('lag-due', { state: 'pending', createdAt: new Date(now.getTime() - 300_000), nextAttemptAt: new Date(now.getTime() - 300_000) });
    await row('lag-expired', { state: 'leased', leaseUntil: new Date(now.getTime() - 240_000), nextAttemptAt: new Date(now.getTime() - 240_000) });
    await row('lag-done-old', { state: 'dispatched', dispatchedAt: new Date(now.getTime() - 900_000) });
    await row('lag-done', { state: 'dispatched', dispatchedAt: new Date(now.getTime() - 600_000) });
    expect(await schedulerLiveness(h.db, now)).toEqual({ outboxLagSeconds: 300, lastDispatchAt: new Date(now.getTime() - 600_000).toISOString() });
  });

  it('the commit is the first seven characters of RENDER_GIT_COMMIT, else GIT_COMMIT, else unknown', () => {
    expect(deployedCommit({ RENDER_GIT_COMMIT: 'fecbc596c979189736ab5daae5f7656fa049da28', GIT_COMMIT: 'abcdef0123' })).toBe('fecbc59');
    expect(deployedCommit({ GIT_COMMIT: 'abcdef0123' })).toBe('abcdef0');
    expect(deployedCommit({})).toBeNull();
  });

  it('/api/health reports lag and the last dispatch, stays ok however late the work is, and never names the commit', async () => {
    process.env.RENDER_GIT_COMMIT = 'fecbc596c979189736ab5daae5f7656fa049da28';
    // Due an hour ago by the real clock the route uses: a stalled dispatcher, which must not fail the check (Render
    // restarts a service whose health check fails, and a restart does not start a dispatcher).
    await row('health-due', { state: 'pending', nextAttemptAt: new Date(Date.now() - 3_600_000) });
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true });
    expect(body.outboxLagSeconds).toBeGreaterThanOrEqual(3_600);
    expect(body.lastDispatchAt).toBe(new Date('2026-10-10T11:50:00Z').toISOString());
    expect(JSON.stringify(body)).not.toMatch(/fecbc59|commit/i);
  });

  it('the staff operations page shows the deployed commit and the dispatcher lag', async () => {
    process.env.RENDER_GIT_COMMIT = 'fecbc596c979189736ab5daae5f7656fa049da28';
    const { default: Operations } = await import('@/app/admin/operations/page');
    const html = renderToStaticMarkup(await Operations());
    expect(html).toContain('commit <code>fecbc59</code>');
    expect(html).toMatch(/dispatcher lag \d{4,}s · last dispatch 2026-10-10T11:50:00\.000Z/);
    expect(html).toContain('work due for over five minutes: is the dispatcher running?');
  });
});

describe('an email that dead-letters before it is a request reaches a person (audit gap 18)', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  const env = testEnv({ STAFF_EMAIL_ALLOWLIST: 'tobias@ticketguy.now,ops@ticketguy.now' });

  const unread = async (key: string, error: string) => {
    const [ev] = await h.db.insert(t.inboundEvents).values({ provider: 'resend', providerEventId: `svix-${key}`, eventType: 'email.received', payloadHash: key, payload: { type: 'email.received', data: { email_id: `em_${key}`, subject: 'Surprise party at 42 Wallaby Way' } }, signatureVerified: true }).returning();
    await h.db.insert(t.outboxEvents).values({ eventType: 'email.received', eventKey: `received:svix-${key}`, entityId: ev!.id, payload: { inboundEventId: ev!.id }, state: 'dead', attempts: 8, lastError: error });
    return ev!;
  };

  it('the dead letter raises the staff alert once, keyed to the inbound event', async () => {
    const ev = await unread('a1', 'RESEND_API_KEY missing; cannot retrieve received email');
    const c = makeConcierge(h, { env });
    const handOff = (id: string) => c.handOffFailedWork({ eventType: 'email.received', payload: { inboundEventId: id }, error: 'RESEND_API_KEY missing; cannot retrieve received email' });
    expect(await handOff(ev.id)).toBe('handed_off');
    expect(await handOff(ev.id)).toBe('already_handled');
    const alerts = await h.db.select().from(t.outboxEvents).where(eq(t.outboxEvents.eventType, 'staff.alert'));
    expect(alerts.map((a) => ({ key: a.eventKey, payload: a.payload }))).toEqual([{ key: `staff_alert:inbound:${ev.id}`, payload: { inboundEventId: ev.id } }]);
    // Read after all, or set aside with its reason: nobody is waiting on a person.
    const done = await unread('a2', 'boom');
    await h.db.update(t.inboundEvents).set({ processingState: 'processed' }).where(eq(t.inboundEvents.id, done.id));
    expect(await handOff(done.id)).toBe('already_handled');
    expect(await c.handOffFailedWork({ eventType: 'email.received', payload: {}, error: 'x' })).toBe('not_customer_work');
  });

  it('the alert says why, when it came and how to find it, links Operations, and carries none of the customer’s words', async () => {
    const ev = await unread('b1', 'RESEND_API_KEY missing; cannot retrieve received email');
    const provider = new RecordingProvider();
    const c = makeConcierge(h, { env, provider });
    expect(await c.alertStaff({ inboundEventId: ev.id })).toEqual({ outcome: 'sent' });
    expect(provider.sent.map((s) => s.to).sort()).toEqual(['ops@ticketguy.now', 'tobias@ticketguy.now']);
    const alert = provider.sent[0]!;
    expect(alert.subject).toBe('Needs a person: an email could not be read');
    expect(alert.text).toContain("A customer's email could not be read, so it has no request and nobody has replied");
    expect(alert.text).toContain('RESEND_API_KEY missing; cannot retrieve received email');
    expect(alert.text).toContain('provider email id em_b1');
    expect(alert.text).toContain('/admin/operations');
    expect(alert.text).not.toContain('Wallaby');
    expect(alert.text).not.toMatch(/[—–]/);
    expect(alert.idempotencyKey).toBe(`staff-alert:inbound:${ev.id}:${alert.to}`);
    // An email read after all (a replay got through) is no longer waiting on anyone.
    await h.db.update(t.inboundEvents).set({ processingState: 'processed' }).where(eq(t.inboundEvents.id, ev.id));
    expect(await makeConcierge(h, { env, provider: new RecordingProvider() }).alertStaff({ inboundEventId: ev.id })).toEqual({ outcome: 'skipped', reason: 'no_longer_waiting' });
  });
});
