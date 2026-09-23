'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Variable = { name: string; kind: string; description: string };
type Signature = { id: string; name: string; body: string };

/**
 * Authoring surface for one template slot. Preview renders server-side against sample data, so what is
 * shown is the same renderer a real send uses — minus the compliance footer, which is appended after the
 * signature and is not editable here.
 */
export function TemplateEditor({
  slot,
  label,
  description,
  variables,
  signatures,
  initialSubject,
  initialBody,
  initialSignatureId,
  builtInBody,
}: {
  slot: string;
  label: string;
  description: string;
  variables: Variable[];
  signatures: Signature[];
  initialSubject: string | null;
  initialBody: string;
  initialSignatureId: string | null;
  builtInBody: string;
}) {
  const router = useRouter();
  const [subject, setSubject] = useState(initialSubject ?? '');
  const [body, setBody] = useState(initialBody);
  const [signatureId, setSignatureId] = useState(initialSignatureId ?? '');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<{ subject: string | null; text: string; signatureText: string | null } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const post = async (payload: Record<string, unknown>) => {
    setStatus('…');
    setIssues([]);
    const res = await fetch('/api/admin/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      setIssues(Array.isArray(j.issues) ? (j.issues as string[]) : [String(j.error ?? 'failed')]);
      setStatus(null);
      return null;
    }
    setStatus('ok');
    return j;
  };

  const signatureBody = signatures.find((s) => s.id === signatureId)?.body ?? null;

  return (
    <section className="rounded border border-gray-200 p-4">
      <h3 className="font-semibold">{label} <code className="text-xs font-normal text-gray-500">{slot}</code></h3>
      <p className="mt-1 text-sm text-gray-600">{description}</p>

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-gray-700">Placeholders and formatting</summary>
        <ul className="mt-1 space-y-1 text-gray-700">
          {variables.length ? variables.map((v) => (
            <li key={v.name}><code>{`{{${v.name}}}`}</code> — {v.description}{v.kind === 'list' ? ' (a list: put it alone on a line for bullets)' : v.kind === 'flag' ? ' (a yes/no: its paragraph is dropped when it is no)' : ''}</li>
          )) : <li>This template takes no placeholders.</li>}
          <li>Blank lines separate paragraphs. A paragraph whose placeholder has no value is left out entirely.</li>
          <li>Lines starting with <code>- </code> become bullets. Bare <code>https://</code> links become links.</li>
          <li>Plain text only — the HTML version is generated. The compliance footer is always added after your signature.</li>
        </ul>
        <pre className="mt-2 overflow-x-auto rounded bg-gray-50 p-2 text-xs text-gray-700">{builtInBody}</pre>
        <p className="text-xs text-gray-500">The built-in copy, as a starting point.</p>
      </details>

      <label className="mt-3 block text-sm">
        <span className="font-medium">Subject <span className="font-normal text-gray-500">(optional — leave blank to keep the current subject logic)</span></span>
        <input className="tg-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Re: your {{eventLabel}} request" />
      </label>

      <label className="mt-3 block text-sm">
        <span className="font-medium">Body</span>
        <textarea className="tg-input font-mono text-sm" rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="font-medium">Signature</span>
          <select className="tg-input" value={signatureId} onChange={(e) => setSignatureId(e.target.value)}>
            <option value="">— Ticket Guy (default sign-off)</option>
            {signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="font-medium">Note <span className="font-normal text-gray-500">(why this change)</span></span>
          <input className="tg-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>

      {issues.length ? (
        <ul className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="tg-btn-secondary"
          onClick={async () => {
            const j = await post({ action: 'preview', slot, subject: subject || null, body, signature: signatureBody });
            if (j) setPreview({ subject: (j.subject as string) ?? null, text: String(j.text ?? ''), signatureText: (j.signatureText as string) ?? null });
          }}
        >
          Preview with sample data
        </button>
        <button
          className="tg-btn-secondary"
          onClick={async () => {
            if (await post({ action: 'save', slot, subject: subject || null, body, signatureId: signatureId || null, note: note || null, activate: false })) router.refresh();
          }}
        >
          Save as draft
        </button>
        <button
          className="tg-btn"
          onClick={async () => {
            if (!window.confirm(`Activate this ${label} template? Every ${label.toLowerCase()} email sent from now on uses it.`)) return;
            if (await post({ action: 'save', slot, subject: subject || null, body, signatureId: signatureId || null, note: note || null, activate: true })) router.refresh();
          }}
        >
          Save and activate
        </button>
        {status ? <span className="text-xs text-gray-600">{status}</span> : null}
      </div>

      {preview ? (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-semibold text-amber-900">PREVIEW — sample data, not a real request. The compliance footer is added on send.</p>
          {preview.subject ? <p className="mt-2 text-sm"><strong>Subject:</strong> {preview.subject}</p> : null}
          <pre className="mt-2 whitespace-pre-wrap text-sm text-gray-900">{preview.text}</pre>
          {preview.signatureText ? <pre className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{preview.signatureText}</pre> : null}
        </div>
      ) : null}
    </section>
  );
}
