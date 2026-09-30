'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * Write in as a test customer: a new request, or (with `replyToRequestId`) a reply in that request's thread.
 * Images are attached the way a customer attaches a screenshot. Posts to /api/admin/test-inbound.
 */
export function TestMessageForm({ replyToRequestId, defaultFrom, defaultText }: { replyToRequestId?: string; defaultFrom?: string; defaultText?: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const router = useRouter();
  const reply = !!replyToRequestId;
  return (
    <form
      className="grid gap-2 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        const files = (fd.getAll('files') as File[]).filter((f) => f.size > 0);
        setStatus('…');
        setCreated(null);
        const attachments = await Promise.all(
          files.map(async (f) => {
            const bytes = new Uint8Array(await f.arrayBuffer());
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return { filename: f.name, contentType: f.type || null, base64: btoa(bin) };
          }),
        );
        const str = (k: string) => (String(fd.get(k) ?? '').trim() || null);
        const res = await fetch('/api/admin/test-inbound', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: str('from'), name: str('name'), subject: str('subject'), text: String(fd.get('text') ?? ''), replyToRequestId: replyToRequestId ?? null, quote: reply ? fd.get('quote') === 'on' : true, attachments }),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; requestId?: string | null; outcome?: string };
        if (!res.ok) {
          setStatus(`${res.status}: ${j.error ?? 'failed'}${j.issues ? ' ' + JSON.stringify(j.issues) : ''}`);
          return;
        }
        setStatus(j.outcome === 'queued' ? 'Received. The reply appears on the request page once it is written.' : `Stored as ${j.outcome}.`);
        if (j.requestId && j.requestId !== replyToRequestId) setCreated(j.requestId);
        form.reset();
        router.refresh();
      }}
    >
      <label className="text-sm">
        <span className="block font-medium">From {reply ? '(blank = this customer)' : ''}</span>
        <input name="from" type="email" className="tg-input" required={!reply} placeholder={reply ? defaultFrom : 'alex+test1@example.com'} defaultValue={reply ? undefined : defaultFrom} />
      </label>
      <label className="text-sm">
        <span className="block font-medium">Name on the account (optional)</span>
        <input name="name" className="tg-input" placeholder="Alex Rivera" />
      </label>
      <label className="text-sm sm:col-span-2">
        <span className="block font-medium">Subject {reply ? '(blank = Re: our last email)' : ''}</span>
        <input name="subject" className="tg-input" placeholder={reply ? undefined : 'Knicks tickets'} />
      </label>
      <label className="text-sm sm:col-span-2">
        <span className="block font-medium">Email</span>
        <textarea name="text" className="tg-input" rows={5} required defaultValue={defaultText} />
      </label>
      <label className="text-sm">
        <span className="block font-medium">Screenshots (up to 3 images)</span>
        <input name="files" type="file" accept="image/png,image/jpeg,image/webp" multiple className="mt-1 text-sm" />
      </label>
      {reply ? (
        <label className="text-sm">
          <span className="block font-medium">Quote our email below, like Gmail</span>
          <input name="quote" type="checkbox" defaultChecked className="mt-1" />
        </label>
      ) : null}
      <div className="sm:col-span-2">
        <button className="tg-btn" type="submit">{reply ? 'Reply as the customer' : 'Send test request'}</button>
        {status ? <span className="ml-3 text-xs text-gray-600">{status}</span> : null}
        {created ? <Link className="ml-3 text-xs underline" href={`/admin/requests/${created}`}>Open the request</Link> : null}
      </div>
    </form>
  );
}
