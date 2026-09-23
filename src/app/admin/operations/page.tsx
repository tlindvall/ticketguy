import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { outboxLag } from '@/lib/intake/outbox';
import { loadSwitches } from '@/lib/email/send-gate';
import { ActionButton } from '@/components/ActionButton';
import { JsonForm } from '@/components/JsonForm';
import { DbMediaStore } from '@/lib/media/storage';

export const dynamic = 'force-dynamic';

export default async function Operations() {
  const staff = await guardPage();
  const e = env();
  const { db, driver } = await getDb();
  const now = new Date();
  const lag = await outboxLag(db, now);
  const dead = await db.select().from(t.outboxEvents).where(eq(t.outboxEvents.state, 'dead')).orderBy(desc(t.outboxEvents.createdAt)).limit(50);
  const switches = await loadSwitches(db);
  const intentStates = await db.select({ state: t.sendIntents.state, n: sql<number>`count(*)::int` }).from(t.sendIntents).groupBy(t.sendIntents.state);
  const uncertain = await db.select().from(t.sendIntents).where(eq(t.sendIntents.state, 'uncertain')).limit(20);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [spend] = await db.select({ usd: sql<number>`coalesce(sum(case when kind='released' then -estimated_usd_micros else estimated_usd_micros end),0)::bigint` }).from(t.usageLedger).where(gte(t.usageLedger.createdAt, dayStart));
  const media = await new DbMediaStore(db, e.MEDIA_MAX_TOTAL_BYTES).usage();
  const staleApprovals = await db.select({ n: sql<number>`count(*)::int` }).from(t.recommendations).where(and(eq(t.recommendations.reviewStatus, 'approved'), lt(t.recommendations.expiresAt, now)));
  const quarantined = await db.select({ n: sql<number>`count(*)::int` }).from(t.inboundEvents).where(eq(t.inboundEvents.processingState, 'quarantined'));
  const pendingMedia = await db.select({ n: sql<number>`count(*)::int` }).from(t.attachments).where(eq(t.attachments.validationState, 'pending_budget'));
  const sourceFailures = await db.select({ sourceId: t.sourceChecks.sourceId, status: t.sourceChecks.status, n: sql<number>`count(*)::int` }).from(t.sourceChecks).where(and(gte(t.sourceChecks.observedAt, new Date(now.getTime() - 86_400_000)), sql`${t.sourceChecks.status} in ('timeout','blocked','rate_limited','provider_error','budget_exhausted')`)).groupBy(t.sourceChecks.sourceId, t.sourceChecks.status);

  return (
    <main className="space-y-8">
      <header>
        <h1 className="text-xl font-bold">Operations</h1>
        <p className="mt-1 text-sm text-gray-600">env {e.appEnv} · mode <strong>{e.APP_MODE}</strong> · db {driver} · email send {e.EMAIL_SEND_ENABLED ? 'ENABLED' : 'disabled'} · marketing {e.MARKETING_SEND_ENABLED ? 'ENABLED' : 'disabled'} · watches {e.WATCH_SEND_ENABLED ? 'ENABLED' : 'disabled'} · human review {e.HUMAN_REVIEW_REQUIRED ? 'required' : 'OFF'}</p>
      </header>
      <section className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded border border-gray-200 p-3"><h2 className="font-medium">Outbox</h2><p>pending {lag.pending} · dead {lag.dead} · oldest pending {lag.oldestPendingSeconds ?? 0}s</p></div>
        <div className="rounded border border-gray-200 p-3"><h2 className="font-medium">AI spend today</h2><p>${(Number(spend?.usd ?? 0) / 1e6).toFixed(3)} of ${e.aiGlobalDailyBudgetUsd.toFixed(2)} cap</p></div>
        <div className="rounded border border-gray-200 p-3"><h2 className="font-medium">Media</h2><p>{(media.totalBytes / 1048576).toFixed(1)} MiB of {(media.budgetBytes / 1048576).toFixed(0)} MiB {media.ratio >= 0.8 ? <span className="tg-badge tg-badge-warn">≥80%</span> : null}</p><p>pending-budget attachments: {pendingMedia[0]?.n ?? 0}</p></div>
        <div className="rounded border border-gray-200 p-3"><h2 className="font-medium">Sends by state</h2><ul>{intentStates.map((s) => <li key={s.state}>{s.state}: {s.n}</li>)}</ul></div>
        <div className="rounded border border-gray-200 p-3"><h2 className="font-medium">Attention</h2><p>stale approvals: {staleApprovals[0]?.n ?? 0}</p><p>quarantined webhooks: {quarantined[0]?.n ?? 0}</p><p>uncertain sends: {uncertain.length}</p></div>
        <div className="rounded border border-gray-200 p-3"><h2 className="font-medium">Source failures (24h)</h2>{sourceFailures.length ? <ul>{sourceFailures.map((f) => <li key={f.sourceId + f.status}>{f.sourceId}: {f.status} ×{f.n}</li>)}</ul> : <p>none</p>}</div>
      </section>
      <section>
        <h2 className="font-semibold">Kill switches <span className="text-xs font-normal text-gray-500">(enabled = capability allowed; evaluated at every dispatch)</span></h2>
        <table className="tg-table mt-2"><thead><tr><th>Switch</th><th>State</th><th></th></tr></thead>
          <tbody>{Object.entries(switches).map(([k, v]) => <tr key={k}><td>{k}</td><td><span className={`tg-badge ${v ? 'tg-badge-ok' : 'tg-badge-danger'}`}>{v ? 'allowed' : 'STOPPED'}</span></td><td>{staff.role === 'admin' ? <ActionButton url="/api/admin/switches" body={{ key: k, enabled: !v, reason: v ? 'staff stop' : 'staff resume' }} label={v ? 'Stop' : 'Resume'} /> : null}</td></tr>)}</tbody>
        </table>
      </section>
      <section>
        <h2 className="font-semibold">Uncertain sends (reconcile against provider before any resend)</h2>
        {uncertain.length ? <ul className="mt-1 text-sm">{uncertain.map((u) => <li key={u.id}>{u.id.slice(0, 8)} · {u.messageClass} · key {u.dedupeKey} · submitted {u.submittedAt?.toISOString() ?? '—'} · {u.lastError}</li>)}</ul> : <p className="text-sm text-gray-600">None.</p>}
      </section>
      <section>
        <h2 className="font-semibold">Dead-lettered outbox events</h2>
        {dead.length ? <table className="tg-table mt-2"><thead><tr><th>Event</th><th>Type</th><th>Attempts</th><th>Error</th><th></th></tr></thead><tbody>{dead.map((d) => <tr key={d.id}><td>{d.eventKey}</td><td>{d.eventType}</td><td>{d.attempts}</td><td className="text-xs">{d.lastError}</td><td>{staff.role === 'admin' ? <ActionButton url={`/api/admin/outbox/${d.id}/replay`} label="Replay (same key)" /> : null}</td></tr>)}</tbody></table> : <p className="text-sm text-gray-600">None.</p>}
      </section>
      {e.APP_MODE === 'fixture' ? (
        <section className="rounded border border-amber-300 bg-amber-50 p-3">
          <h2 className="font-semibold">Inbound simulator (fixture mode only)</h2>
          <p className="text-xs text-amber-900">Feeds the normalized inbound contract directly. It does not exercise provider signature verification.</p>
          <div className="mt-2"><JsonForm url="/api/admin/simulate-inbound" submitLabel="Simulate inbound email" fields={[{ name: 'from', label: 'From', required: true, defaultValue: 'alice@customer.example' }, { name: 'subject', label: 'Subject', defaultValue: 'Rangers tickets' }, { name: 'inReplyTo', label: 'In-Reply-To (optional, to continue a thread)' }, { name: 'text', label: 'Body', type: 'textarea', required: true, defaultValue: 'Five of us want the New York Rangers preseason game at MSG on Oct 3, sitting together, $450 total. We definitely have to go.' }]} extra={{ drain: true }} /></div>
        </section>
      ) : null}
    </main>
  );
}
