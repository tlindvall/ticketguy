import { notFound } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { ActionButton } from '@/components/ActionButton';
import { aggregateInterest } from '@/lib/domain/interests';

export const dynamic = 'force-dynamic';

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await guardPage();
  const { id } = await params;
  const { db } = await getDb();
  const [c] = await db.select().from(t.contacts).where(eq(t.contacts.id, id));
  if (!c) notFound();
  const obs = await db.select().from(t.interestObservations).where(eq(t.interestObservations.contactId, id)).orderBy(desc(t.interestObservations.observedAt));
  const perms = await db.select().from(t.marketingPermissions).where(eq(t.marketingPermissions.contactId, id)).orderBy(desc(t.marketingPermissions.createdAt));
  const sups = await db.select().from(t.suppressions).where(eq(t.suppressions.emailLookup, c.emailLookup));
  const requests = await db.select().from(t.requests).where(eq(t.requests.contactId, id)).orderBy(desc(t.requests.createdAt));
  const byTag = new Map<string, typeof obs>();
  for (const o of obs) (byTag.get(o.tagKey) ?? byTag.set(o.tagKey, []).get(o.tagKey)!).push(o);
  const now = new Date();
  return (
    <main className="space-y-8">
      <h1 className="text-xl font-bold">{c.emailOriginal} <span className="tg-badge tg-badge-muted">{c.status}</span></h1>
      <p className="text-sm text-gray-600">Country: {c.countryConfirmed ?? 'unconfirmed'} · first seen {c.createdAt.toISOString().slice(0, 10)} · last inbound {c.lastInboundAt?.toISOString().slice(0, 16) ?? '—'}</p>
      <section>
        <h2 className="font-semibold">Interests (evidence-backed; separate from marketing permission)</h2>
        <table className="tg-table mt-2"><thead><tr><th>Tag</th><th>Aggregate</th><th>Status</th><th>Evidence</th></tr></thead>
          <tbody>{[...byTag.entries()].map(([tag, list]) => { const agg = aggregateInterest(list.map((o) => ({ polarity: o.polarity as 'positive' | 'negative' | 'uncertain', confidence: o.confidence, observedAt: o.observedAt, explicit: o.explicit })), null, now); return <tr key={tag}><td><code>{tag}</code></td><td>{agg.aggregateConfidence}</td><td><span className={`tg-badge ${agg.status === 'confirmed' ? 'tg-badge-ok' : 'tg-badge-muted'}`}>{agg.status}</span></td><td className="text-xs text-gray-600">{list.map((o) => `${o.polarity}/${o.confidence}${o.explicit ? ' explicit' : ''}${o.forSelf === false ? ' gift' : ''} @ ${o.observedAt.toISOString().slice(0, 10)}`).join('; ')}</td></tr>; })}</tbody>
        </table>
      </section>
      <section>
        <h2 className="font-semibold">Marketing permission</h2>
        {perms.length ? <ul className="mt-1 text-sm">{perms.map((p) => <li key={p.id}>{p.createdAt.toISOString().slice(0, 16)} · <strong>{p.status}</strong> · {p.method} · notice {p.noticeVersion}</li>)}</ul> : <p className="text-sm text-gray-600">No permission record. Service requests never grant marketing permission.</p>}
        <h3 className="mt-3 font-medium">Suppressions</h3>
        {sups.length ? <ul className="text-sm">{sups.map((s) => <li key={s.id}><span className="tg-badge tg-badge-warn">{s.scope}</span> {s.reason} {s.provider ? `(${s.provider})` : ''} {s.createdAt.toISOString().slice(0, 16)}</li>)}</ul> : <p className="text-sm text-gray-600">None.</p>}
      </section>
      <section>
        <h2 className="font-semibold">Requests</h2>
        <ul className="text-sm">{requests.map((r) => <li key={r.id}><a className="underline" href={`/admin/requests/${r.id}`}>{r.id.slice(0, 8)}</a> · {r.state} · rev {r.currentRevision}</li>)}</ul>
      </section>
      <section>
        <h2 className="font-semibold">Deletion</h2>
        <p className="text-sm text-gray-600">Admin only. Requires a verified identity (customer CONFIRM reply or staff identity check). Stops watches, suppresses, deletes/redacts personal content and media; keeps a keyed suppression + ledger row so restores re-apply it.</p>
        {staff.role === 'admin' && c.status !== 'deleted' ? <div className="mt-2"><ActionButton url={`/api/admin/contacts/${id}/delete`} body={{ verifiedBy: 'staff_identity_check', note: 'Deleted from staff console' }} label="Delete this contact's data" confirm="This deletes/redacts personal content and cannot be undone. Continue?" /></div> : null}
      </section>
    </main>
  );
}
