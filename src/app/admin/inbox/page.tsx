import Link from 'next/link';
import { desc, sql, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { nowMs } from '@/lib/util/clock';

export const dynamic = 'force-dynamic';

const PRIORITY: Record<string, number> = { awaiting_review: 0, manual_attention: 1, needs_clarification: 2, researching: 3, interpreting: 4, received: 5, monitoring: 6, recommendation_sent: 7 };

export default async function Inbox({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  await guardPage();
  const { state } = await searchParams;
  const { db } = await getDb();
  const open = ['received', 'interpreting', 'needs_clarification', 'resolving_event', 'researching', 'awaiting_review', 'manual_attention', 'recommendation_sent', 'monitoring'];
  const rows = await db
    .select({ id: t.requests.id, state: t.requests.state, category: t.requests.category, revision: t.requests.currentRevision, updatedAt: t.requests.updatedAt, deadlineAt: t.requests.deadlineAt, owner: t.requests.ownerUserId, contactId: t.requests.contactId, unread: sql<number>`(select count(*)::int from ${t.messages} m where m.conversation_id = ${t.requests.conversationId} and m.direction = 'inbound' and m.received_at > ${t.requests.updatedAt})` })
    .from(t.requests)
    .where(state ? sql`${t.requests.state} = ${state}` : inArray(t.requests.state, open))
    .orderBy(desc(t.requests.updatedAt))
    .limit(200);
  rows.sort((a, b) => (PRIORITY[a.state] ?? 9) - (PRIORITY[b.state] ?? 9) || a.updatedAt.getTime() - b.updatedAt.getTime());
  const now = nowMs();
  return (
    <main>
      <h1 className="text-xl font-bold">Inbox</h1>
      <p className="mt-1 text-sm text-gray-600">{rows.length} open request(s). Sorted by review priority, then waiting age.</p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {['', 'awaiting_review', 'manual_attention', 'needs_clarification', 'researching', 'monitoring', 'closed', 'unsupported'].map((s) => (
          <Link key={s} href={s ? `/admin/inbox?state=${s}` : '/admin/inbox'} className={`tg-badge ${state === s || (!state && !s) ? 'tg-badge-ok' : 'tg-badge-muted'}`}>{s || 'open'}</Link>
        ))}
      </div>
      <table className="tg-table mt-4">
        <thead><tr><th>Request</th><th>State</th><th>Category</th><th>Rev</th><th>Waiting</th><th>Deadline</th><th>Owner</th><th>Unread</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><Link className="underline" href={`/admin/requests/${r.id}`}>{r.id.slice(0, 8)}</Link></td>
              <td><span className={`tg-badge ${r.state === 'awaiting_review' ? 'tg-badge-warn' : r.state === 'manual_attention' ? 'tg-badge-danger' : 'tg-badge-muted'}`}>{r.state}</span></td>
              <td>{r.category ?? '—'}</td>
              <td>{r.revision}</td>
              <td>{Math.round((now - r.updatedAt.getTime()) / 60000)} min</td>
              <td>{r.deadlineAt ? r.deadlineAt.toISOString().slice(0, 16) : '—'}</td>
              <td>{r.owner ?? '—'}</td>
              <td>{r.unread > 0 ? <span className="tg-badge tg-badge-warn">{r.unread}</span> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
