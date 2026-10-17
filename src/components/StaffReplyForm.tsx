'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Answer the customer from the request page: the held reply as drafted (unchanged text sends the original email, links and
 * cards included), edited, or written from scratch. The sign-off and footer are added when it is sent.
 */
export function StaffReplyForm({ requestId, heldId, draft }: { requestId: string; heldId: string | null; draft: string }) {
  const [body, setBody] = useState(draft);
  const [state, setState] = useState<string | null>(null);
  const router = useRouter();
  const unchanged = heldId !== null && body.trim() === draft.trim();
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!window.confirm(unchanged ? 'Send the held reply to the customer as it was drafted?' : 'Send this reply to the customer now?')) return;
        setState('…');
        const res = await fetch(`/api/admin/requests/${requestId}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ heldId, body }) });
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setState(res.ok ? 'sent' : `${res.status}: ${String(j.error ?? 'failed')}`);
        router.refresh();
      }}
    >
      <textarea className="w-full rounded-md border border-gray-300 p-2 font-sans text-sm leading-relaxed" rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex items-center gap-2">
        <button className="tg-btn" type="submit" disabled={!body.trim()}>{unchanged ? 'Send as drafted' : 'Send this reply'}</button>
        {heldId && !unchanged ? <button className="tg-btn-secondary" type="button" onClick={() => setBody(draft)}>Back to the draft</button> : null}
        {state ? <span className="text-xs text-gray-600">{state}</span> : null}
      </div>
    </form>
  );
}
