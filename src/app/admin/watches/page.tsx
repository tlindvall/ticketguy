import { asc, desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { ActionButton } from '@/components/ActionButton';
import { formatUsd } from '@/lib/domain/money';
import { nowMs } from '@/lib/util/clock';
import { env } from '@/lib/config/env';
import { marketById } from '@/lib/domain/markets';
import { ago, whenLocal, whenStaff } from '@/lib/admin/labels';

export const dynamic = 'force-dynamic';

const ALERT_STATE: Record<string, [string, string]> = {
  active: ['Waiting', 'tg-badge-ok'],
  sent: ['Emailed', 'tg-badge-muted'],
  cancelled: ['Cancelled', 'tg-badge-muted'],
  expired: ['Expired', 'tg-badge-muted'],
};

/**
 * Everything we are watching for customers. Sale and new-date alerts need no resale data and email the
 * customer by themselves; price watches need a seller we may check on a schedule, and their alerts wait for
 * a person to approve them.
 */
export default async function Watches() {
  await guardPage();
  const e = env();
  const { db } = await getDb();
  const now = nowMs();

  const alerts = await db.select({ a: t.eventAlerts, email: t.contacts.emailOriginal }).from(t.eventAlerts).innerJoin(t.contacts, eq(t.contacts.id, t.eventAlerts.contactId)).orderBy(desc(t.eventAlerts.createdAt)).limit(200);
  const eventIds = [...new Set(alerts.map((r) => r.a.eventId).filter((x): x is string => !!x))];
  const events = eventIds.length ? await db.select({ id: t.events.id, name: t.events.name, at: t.events.localStartAt, saleAt: t.events.publicSaleStartAt, tz: t.venues.timezone, venue: t.venues.name }).from(t.events).innerJoin(t.venues, eq(t.venues.id, t.events.venueId)).where(inArray(t.events.id, eventIds)) : [];
  const eventOf = new Map(events.map((x) => [x.id, x]));
  const waiting = alerts.filter((r) => r.a.state === 'active');
  const done = alerts.filter((r) => r.a.state !== 'active').slice(0, 30);

  const watches = await db.select({ w: t.watches, e: t.events }).from(t.watches).innerJoin(t.events, eq(t.events.id, t.watches.eventId)).orderBy(asc(t.watches.nextCheckAt)).limit(200);
  const pendingPriceAlerts = await db.select().from(t.watchAlerts).where(eq(t.watchAlerts.approvalState, 'pending')).orderBy(desc(t.watchAlerts.createdAt)).limit(100);
  const configs = await db.select().from(t.adapterConfigs);
  const monitoring = configs.filter((c) => c.enabled && c.monitoringAllowed).map((c) => c.sourceId);

  const what = (a: typeof t.eventAlerts.$inferSelect) => {
    if (a.kind === 'on_sale') {
      const ev = a.eventId ? eventOf.get(a.eventId) : undefined;
      return { title: ev ? `${ev.name} — ${whenLocal(ev.at, ev.tz)}, ${ev.venue}` : 'An event', detail: ev?.saleAt ? `General sale opens ${whenLocal(ev.saleAt, ev.tz)}` : 'Waiting for the general sale' };
    }
    const mk = a.marketId ? marketById(a.marketId) : null;
    return { title: `${a.keyword ?? 'A performer'}${mk ? ` in ${mk.label}` : ''}`, detail: 'Waiting for a date to be announced' };
  };

  return (
    <main className="space-y-10">
      <header>
        <h1 className="text-2xl font-bold">Price watches and alerts</h1>
        <p className="mt-1 text-sm text-gray-600">What we are keeping an eye on for customers. Nothing here needs you unless a price alert is waiting for approval.</p>
      </header>

      <section>
        <h2 className="text-lg font-semibold">Sale and new-date alerts <span className="tg-badge tg-badge-muted">{waiting.length} waiting</span></h2>
        <p className="mt-1 text-sm text-gray-600">
          A customer asked us to email them when tickets go on sale, or when a date is announced. We check Ticketmaster about once a day (right after a published sale time), and the email goes out by itself — it has no prices in it.
        </p>
        {!e.EVENT_ALERTS_ENABLED ? (
          <p className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
            <strong>Switched off.</strong> Customers are not offered alerts and none are checked. Turn on with <code>EVENT_ALERTS_ENABLED=true</code> once Ticketmaster&rsquo;s terms are confirmed to allow scheduled checks that notify customers.
          </p>
        ) : null}
        {waiting.length ? (
          <ul className="mt-3 divide-y divide-gray-200 rounded-lg border border-gray-200">
            {waiting.map(({ a, email }) => {
              const w = what(a);
              return (
                <li key={a.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tg-badge tg-badge-info">{a.kind === 'on_sale' ? 'When it goes on sale' : 'When a date is announced'}</span>
                    <span className="text-gray-600">{email}</span>
                    <span className="ml-auto text-xs text-gray-500">asked {ago(a.createdAt.getTime(), now)}</span>
                  </div>
                  <p className="mt-1 font-medium"><Link className="hover:underline" href={`/admin/requests/${a.requestId}`}>{w.title}</Link></p>
                  <p className="text-xs text-gray-500">{w.detail} · next check {whenStaff(a.nextCheckAt)} · gives up {whenStaff(a.expiresAt)}</p>
                </li>
              );
            })}
          </ul>
        ) : <p className="mt-2 text-sm text-gray-500">None waiting.</p>}
        {done.length ? (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-gray-700">Recently finished ({done.length})</summary>
            <ul className="mt-2 space-y-1">
              {done.map(({ a, email }) => (
                <li key={a.id}><span className={`tg-badge ${ALERT_STATE[a.state]?.[1] ?? 'tg-badge-muted'}`}>{ALERT_STATE[a.state]?.[0] ?? a.state}</span> <Link className="hover:underline" href={`/admin/requests/${a.requestId}`}>{what(a).title}</Link> <span className="text-gray-500">· {email}{a.sentAt ? ` · emailed ${whenStaff(a.sentAt)}` : ''}</span></li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section>
        <h2 className="text-lg font-semibold">Price watches <span className="tg-badge tg-badge-muted">{watches.filter(({ w }) => w.state === 'active').length} active</span></h2>
        {monitoring.length ? (
          <p className="mt-1 text-sm text-gray-600">Checked automatically on: {monitoring.join(', ')}. When a price fits, an alert waits below for your approval.</p>
        ) : (
          <p className="mt-2 rounded border border-gray-200 bg-gray-50 p-2 text-sm text-gray-700">
            <strong>Not running.</strong> A price watch needs a resale seller we are allowed to check on a schedule, and none is connected yet (see <Link className="underline" href="/admin/sources">Sellers</Link>). Customers who ask are told we aren&rsquo;t monitoring automatically, and no watch is created.
          </p>
        )}
        {watches.length ? (
          <table className="tg-table mt-3">
            <thead><tr><th>Event</th><th>Tickets</th><th>Alert under</th><th>Status</th><th>Next check</th><th>Gives up</th><th></th></tr></thead>
            <tbody>{watches.map(({ w, e: ev }) => (
              <tr key={w.id}>
                <td><Link className="underline" href={`/admin/requests/${w.requestId}`}>{ev.name}</Link></td><td>{w.quantity}</td><td>{formatUsd(w.targetTotalCents)} total</td>
                <td><span className={`tg-badge ${w.state === 'active' ? 'tg-badge-ok' : 'tg-badge-muted'}`}>{w.state}</span></td>
                <td>{w.nextCheckAt.getTime() < now && w.state === 'active' ? <span className="tg-badge tg-badge-warn">late</span> : null} {whenStaff(w.nextCheckAt)}</td><td>{whenStaff(w.expiresAt)}</td>
                <td className="space-x-1">
                  {w.state === 'active' ? <ActionButton url={`/api/admin/watches/${w.id}/pause`} body={{ reason: 'staff pause' }} label="Pause" /> : w.state === 'paused' ? <ActionButton url={`/api/admin/watches/${w.id}/pause`} body={{ reason: 'staff resume', resume: true }} label="Resume" /> : null}
                  {w.state === 'active' || w.state === 'paused' ? <ActionButton url={`/api/admin/watches/${w.id}/cancel`} body={{ reason: 'staff cancel' }} label="Cancel" confirm="Cancel this watch?" /> : null}
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}

        <h3 className="mt-6 font-semibold">Price alerts waiting for approval</h3>
        {pendingPriceAlerts.length ? (
          <table className="tg-table mt-2">
            <thead><tr><th>Total</th><th>Found</th><th></th></tr></thead>
            <tbody>{pendingPriceAlerts.map((a) => <tr key={a.id}><td>{formatUsd(a.payableTotalCents)}</td><td>{whenStaff(a.createdAt)}</td><td><ActionButton url={`/api/admin/watch-alerts/${a.id}/approve`} label="Approve and send" variant="primary" /></td></tr>)}</tbody>
          </table>
        ) : <p className="mt-1 text-sm text-gray-500">None.</p>}
      </section>
    </main>
  );
}
