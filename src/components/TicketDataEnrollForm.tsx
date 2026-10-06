'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type EnrollEventOption = { id: string; label: string };
type Suggestion = { kind: string; id: string; name: string; detail: string | null };

/**
 * Enroll a catalog event for TicketData tracking: search TicketData for the event, pick the match,
 * pick the catalog event it corresponds to, enroll. Admin only; the page renders this for admins.
 */
export function TicketDataEnrollForm({ events }: { events: EnrollEventOption[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [searchState, setSearchState] = useState<string | null>(null);
  const [picked, setPicked] = useState<Suggestion | null>(null);
  const [eventId, setEventId] = useState('');
  const [enrollState, setEnrollState] = useState<string | null>(null);

  const search = async () => {
    setSearchState('…');
    setSuggestions(null);
    setPicked(null);
    const res = await fetch(`/api/admin/ticketdata-search?q=${encodeURIComponent(q)}`);
    const j = (await res.json().catch(() => ({}))) as { suggestions?: Suggestion[]; error?: string };
    if (!res.ok) {
      setSearchState(`${res.status}: ${j.error ?? 'failed'}`);
      return;
    }
    setSuggestions(j.suggestions ?? []);
    setSearchState(j.suggestions?.length ? null : 'No matches — try a different spelling.');
  };

  const enroll = async () => {
    if (!picked || !eventId) return;
    setEnrollState('…');
    const res = await fetch('/api/admin/ticketdata-enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId, providerEventId: picked.id }),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; error?: string; status?: string };
    if (!res.ok) {
      setEnrollState(`${res.status}: ${j.error ?? 'failed'}${j.status ? ` (${j.status})` : ''}`);
      return;
    }
    setEnrollState(j.already ? 'Already enrolled.' : 'Enrolled — the next sync will pick it up.');
    router.refresh();
  };

  return (
    <div className="mt-3 rounded-lg border border-gray-200 p-3">
      <h3 className="text-sm font-semibold">Enroll an event</h3>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-600">Find it on TicketData</span>
          <span className="flex gap-2">
            <input className="tg-input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} placeholder="Metallica Mohegan Sun" />
            <button className="tg-btn-secondary" onClick={search}>Search</button>
          </span>
        </label>
      </div>
      {searchState ? <p className="mt-1 text-xs text-gray-600">{searchState}</p> : null}
      {suggestions?.length ? (
        <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-sm">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                className={`w-full rounded border px-2 py-1 text-left ${picked?.id === s.id ? 'border-gray-900 bg-gray-100' : 'border-gray-200'}`}
                onClick={() => setPicked(s)}
              >
                <span className="font-medium">{s.name}</span>
                {s.detail ? <span className="text-gray-600"> — {s.detail}</span> : null}
                <span className="ml-2 text-xs text-gray-500">{s.kind} · {s.id}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {picked ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-gray-600">Our event for “{picked.name}”</span>
            <select className="tg-input" value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="">Pick an event…</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>{e.label}</option>
              ))}
            </select>
          </label>
          <button className="tg-btn" disabled={!eventId} onClick={enroll}>Enroll for TicketData</button>
          {enrollState ? <span className="text-xs text-gray-600">{enrollState}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
