'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Field = { name: string; label: string; type?: 'text' | 'number' | 'checkbox' | 'textarea' | 'datetime'; required?: boolean; placeholder?: string; defaultValue?: string | number | boolean };

/** Minimal accessible form that posts typed JSON to an admin API route. */
/** `extra` is merged into the payload; `nullableCheckboxes` lists checkbox names sent as null when unchecked (tri-state). */
export function JsonForm({ url, fields, submitLabel, extra, nullableCheckboxes }: { url: string; fields: Field[]; submitLabel: string; extra?: Record<string, unknown>; nullableCheckboxes?: string[] }) {
  const [status, setStatus] = useState<string | null>(null);
  const router = useRouter();
  return (
    <form
      className="grid gap-2 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const v: Record<string, unknown> = {};
        for (const f of fields) {
          const raw = fd.get(f.name);
          if (f.type === 'checkbox') v[f.name] = raw === 'on' ? true : nullableCheckboxes?.includes(f.name) ? null : false;
          else if (f.type === 'number') v[f.name] = raw === '' || raw === null ? null : Number(raw);
          else if (f.type === 'datetime') v[f.name] = raw ? new Date(String(raw)).toISOString() : null;
          else v[f.name] = raw === '' || raw === null ? null : String(raw);
        }
        setStatus('…');
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...v, ...(extra ?? {}) }) });
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setStatus(res.ok ? 'saved' : `${res.status}: ${String(j.error ?? 'failed')}${j.issues ? ' ' + JSON.stringify(j.issues) : ''}`);
        router.refresh();
      }}
    >
      {fields.map((f) => (
        <label key={f.name} className={`text-sm ${f.type === 'textarea' ? 'sm:col-span-2' : ''}`}>
          <span className="block font-medium">{f.label}</span>
          {f.type === 'checkbox' ? (
            <input name={f.name} type="checkbox" defaultChecked={!!f.defaultValue} className="mt-1" />
          ) : f.type === 'textarea' ? (
            <textarea name={f.name} className="tg-input" rows={3} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue as string | undefined} />
          ) : (
            <input name={f.name} type={f.type === 'datetime' ? 'datetime-local' : f.type ?? 'text'} className="tg-input" required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue as string | number | undefined} step={f.type === 'number' ? 1 : undefined} />
          )}
        </label>
      ))}
      <div className="sm:col-span-2">
        <button className="tg-btn" type="submit">{submitLabel}</button>
        {status ? <span className="ml-3 text-xs text-gray-600">{status}</span> : null}
      </div>
    </form>
  );
}
