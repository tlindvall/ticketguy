'use client';
import { useState } from 'react';

export function PreferencesForm({ token, initialOptIn, initialCountry }: { token: string; initialOptIn: boolean; initialCountry: 'US' | 'NON_US' | null }) {
  const [optIn, setOptIn] = useState(initialOptIn);
  const [country, setCountry] = useState<'US' | 'NON_US' | ''>(initialCountry ?? '');
  const [status, setStatus] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('Saving…');
    const res = await fetch('/api/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, marketingOptIn: optIn, country: country || null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null }) });
    setStatus(res.ok ? 'Saved.' : 'This link is no longer valid. Reply to any Ticket Guy email to get a fresh one.');
  }
  return (
    <form onSubmit={submit} className="mt-6 space-y-5">
      <label className="flex items-start gap-3">
        <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} className="mt-1" />
        <span>
          <span className="font-medium">Send occasional ticket offers based on my interests</span>
          <span className="block text-sm text-gray-600">Optional. At most two emails a month, at least a week apart. You can turn this off any time.</span>
        </span>
      </label>
      <fieldset>
        <legend className="font-medium">Where are you based?</legend>
        <p className="text-sm text-gray-600">We serve US customers only during the pilot.</p>
        <div className="mt-2 flex gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="country" checked={country === 'US'} onChange={() => setCountry('US')} /> United States</label>
          <label className="flex items-center gap-2"><input type="radio" name="country" checked={country === 'NON_US'} onChange={() => setCountry('NON_US')} /> Somewhere else</label>
        </div>
      </fieldset>
      <button className="tg-btn" type="submit">Save preferences</button>
      {status ? <p role="status" className="text-sm text-gray-700">{status}</p> : null}
    </form>
  );
}
