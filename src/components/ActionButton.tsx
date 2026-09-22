'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Posts JSON to an admin API route and refreshes the page; shows the server's error reason on failure. */
export function ActionButton({ url, body, label, confirm: confirmText, variant = 'secondary' }: { url: string; body?: Record<string, unknown>; label: string; confirm?: string; variant?: 'primary' | 'secondary' }) {
  const [state, setState] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        className={variant === 'primary' ? 'tg-btn' : 'tg-btn-secondary'}
        onClick={async () => {
          if (confirmText && !window.confirm(confirmText)) return;
          setState('…');
          const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
          const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          setState(res.ok ? 'done' : `${res.status}: ${String(j.error ?? j.reason ?? 'failed')}${j.issues ? ' ' + JSON.stringify(j.issues) : ''}`);
          router.refresh();
        }}
      >
        {label}
      </button>
      {state ? <span className="text-xs text-gray-600">{state}</span> : null}
    </span>
  );
}
