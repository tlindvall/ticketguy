'use client';
import { useState } from 'react';
import { authClient } from '@/lib/auth/client';

/** TOTP enrollment. Staff routes refuse access until this is complete (A46). */
export default function SetupMfa() {
  const [password, setPassword] = useState('');
  const [uri, setUri] = useState<string | null>(null);
  const [backup, setBackup] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <main className="mx-auto max-w-lg">
      <h1 className="text-xl font-bold">Set up two-factor authentication</h1>
      <p className="mt-1 text-sm text-gray-600">Required for every staff account. Add the secret to an authenticator app, then verify a code.</p>
      {!uri ? (
        <form className="mt-4 space-y-3" onSubmit={async (e) => { e.preventDefault(); const r = await authClient.twoFactor.enable({ password }); if (r.error) return setMsg(r.error.message ?? 'failed'); const d = r.data as { totpURI?: string; backupCodes?: string[] }; if (!d.totpURI) return setMsg('TOTP not available'); setUri(d.totpURI); setBackup(d.backupCodes ?? []); }}>
          <label className="block text-sm"><span className="font-medium">Confirm password</span><input className="tg-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button className="tg-btn" type="submit">Generate secret</button>
        </form>
      ) : (
        <div className="mt-4 space-y-3 text-sm">
          <p className="font-medium">Authenticator URI (paste into your app or enter the secret manually):</p>
          <code className="block break-all rounded bg-gray-100 p-2">{uri}</code>
          <p className="font-medium">Backup codes (store securely):</p>
          <code className="block rounded bg-gray-100 p-2">{backup.join('  ')}</code>
          <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); const r = await authClient.twoFactor.verifyTotp({ code }); setMsg(r.error ? (r.error.message ?? 'invalid code') : 'Two-factor enabled. You can use the staff console now.'); }}>
            <label className="block"><span className="font-medium">Code from your app</span><input className="tg-input" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required /></label>
            <button className="tg-btn" type="submit">Verify and enable</button>
          </form>
        </div>
      )}
      {msg ? <p role="status" className="mt-3 text-sm">{msg}</p> : null}
    </main>
  );
}
