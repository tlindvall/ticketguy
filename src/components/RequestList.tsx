'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export type RequestRow = { id: string; badge: string; badgeClass: string; newReply: boolean; customer: string; age: string; headline: string; when: string | null; snippet: string | null; why: string };

/**
 * A list of requests. When `removable`, each row has a checkbox and the list a "Remove selected" button:
 * removed requests close as removed by staff (nothing deleted, nothing further sent) and leave the board.
 */
export function RequestList({ rows, empty, removable }: { rows: RequestRow[]; empty: string; removable: boolean }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const router = useRouter();
  if (!rows.length) return <p className="mt-2 text-sm text-gray-500">{empty}</p>;
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const allPicked = rows.every((r) => picked.has(r.id));
  const remove = async () => {
    const ids = rows.filter((r) => picked.has(r.id)).map((r) => r.id);
    if (!ids.length || !window.confirm(`Remove ${ids.length} request${ids.length === 1 ? '' : 's'} from the board? Nothing more will be sent for ${ids.length === 1 ? 'it' : 'them'}. They stay under Closed.`)) return;
    setStatus('Removing…');
    const res = await fetch('/api/admin/requests/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestIds: ids }) });
    const j = (await res.json().catch(() => ({}))) as { removed?: string[]; error?: string };
    setStatus(res.ok ? `Removed ${j.removed?.length ?? 0}.` : `Could not remove: ${j.error ?? res.status}`);
    setPicked(new Set());
    router.refresh();
  };
  return (
    <div className="mt-2">
      {removable ? (
        <div className="mb-2 flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1 text-gray-600">
            <input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))} /> Select all
          </label>
          {picked.size ? <button className="tg-btn-secondary" onClick={remove}>Remove {picked.size} selected</button> : null}
          {status ? <span className="text-xs text-gray-600">{status}</span> : null}
        </div>
      ) : null}
      <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start">
            {removable ? (
              <label className="flex cursor-pointer items-center self-stretch pl-4" aria-label={`Select ${r.headline}`}>
                <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
              </label>
            ) : null}
            <Link href={`/admin/requests/${r.id}`} className="block min-w-0 flex-1 px-4 py-3 hover:bg-gray-50">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`tg-badge ${r.badgeClass}`}>{r.badge}</span>
                {r.newReply ? <span className="tg-badge tg-badge-warn">New reply</span> : null}
                <span className="text-gray-600">{r.customer}</span>
                <span className="ml-auto text-xs text-gray-500">{r.age}</span>
              </div>
              <p className="mt-1 font-medium text-gray-900">
                {r.headline}
                {r.when ? <span className="font-normal text-gray-600"> · {r.when}</span> : null}
              </p>
              {r.snippet ? <p className="mt-0.5 truncate text-sm text-gray-600">&ldquo;{r.snippet}&rdquo;</p> : null}
              {r.why ? <p className="mt-0.5 text-xs text-gray-500">{r.why}</p> : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
