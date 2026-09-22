import { asc, desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { ActionButton } from '@/components/ActionButton';
import { formatUsd } from '@/lib/domain/money';
import { nowMs } from '@/lib/util/clock';

export const dynamic = 'force-dynamic';

export default async function Watches() {
  await guardPage();
  const { db } = await getDb();
  const watches = await db.select({ w: t.watches, e: t.events }).from(t.watches).innerJoin(t.events, eq(t.events.id, t.watches.eventId)).orderBy(asc(t.watches.nextCheckAt)).limit(200);
  const alerts = await db.select().from(t.watchAlerts).where(eq(t.watchAlerts.approvalState, 'pending')).orderBy(desc(t.watchAlerts.createdAt)).limit(100);
  const configs = await db.select().from(t.adapterConfigs);
  const monitoring = configs.filter((c) => c.enabled && c.monitoringAllowed).map((c) => c.sourceId);
  const now = nowMs();
  return (
    <main className="space-y-8">
      <section>
        <h1 className="text-xl font-bold">Watches</h1>
        <p className="mt-1 text-sm text-gray-600">Unattended monitoring coverage: {monitoring.length ? monitoring.join(', ') : <span className="tg-badge tg-badge-warn">none — manual-only sources cannot support watches</span>}</p>
        <table className="tg-table mt-3">
          <thead><tr><th>Watch</th><th>Event</th><th>Qty</th><th>Target</th><th>State</th><th>Cadence</th><th>Next check</th><th>Expires</th><th>Actions</th></tr></thead>
          <tbody>{watches.map(({ w, e }) => (
            <tr key={w.id}>
              <td><Link className="underline" href={`/admin/requests/${w.requestId}`}>{w.id.slice(0, 8)}</Link></td><td>{e.name}</td><td>{w.quantity}</td><td>{formatUsd(w.targetTotalCents)}</td>
              <td><span className={`tg-badge ${w.state === 'active' ? 'tg-badge-ok' : 'tg-badge-muted'}`}>{w.state}</span></td><td>{w.cadenceMinutes} min</td>
              <td>{w.nextCheckAt.getTime() < now && w.state === 'active' ? <span className="tg-badge tg-badge-warn">overdue</span> : null} {w.nextCheckAt.toISOString().slice(0, 16)}</td><td>{w.expiresAt.toISOString().slice(0, 16)}</td>
              <td className="space-x-1">
                {w.state === 'active' ? <ActionButton url={`/api/admin/watches/${w.id}/pause`} body={{ reason: 'staff pause' }} label="Pause" /> : w.state === 'paused' ? <ActionButton url={`/api/admin/watches/${w.id}/pause`} body={{ reason: 'staff resume', resume: true }} label="Resume" /> : null}
                {w.state === 'active' || w.state === 'paused' ? <ActionButton url={`/api/admin/watches/${w.id}/cancel`} body={{ reason: 'staff cancel' }} label="Cancel" confirm="Cancel this watch?" /> : null}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      <section>
        <h2 className="font-semibold">Alerts awaiting approval</h2>
        <table className="tg-table mt-2">
          <thead><tr><th>Alert</th><th>Watch</th><th>Total</th><th>Created</th><th></th></tr></thead>
          <tbody>{alerts.map((a) => <tr key={a.id}><td>{a.id.slice(0, 8)}</td><td>{a.watchId.slice(0, 8)} gen {a.generation}</td><td>{formatUsd(a.payableTotalCents)}</td><td>{a.createdAt.toISOString().slice(0, 16)}</td><td><ActionButton url={`/api/admin/watch-alerts/${a.id}/approve`} label="Approve alert" variant="primary" /></td></tr>)}</tbody>
        </table>
        {!alerts.length ? <p className="text-sm text-gray-600">None pending.</p> : null}
      </section>
    </main>
  );
}
