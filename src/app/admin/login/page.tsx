'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <main className="mx-auto max-w-sm">
      <h1 className="text-xl font-bold">Staff sign in</h1>
      <p className="mt-1 text-sm text-gray-600">Invite-only. There is no public signup.</p>
      {!needsTotp ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            const r = await authClient.signIn.email({ email, password });
            if (r.error) return setError(r.error.message ?? 'sign in failed');
            if ((r.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return setNeedsTotp(true);
            router.push('/admin/inbox');
          }}
        >
          <label className="block text-sm"><span className="font-medium">Email</span><input className="tg-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label className="block text-sm"><span className="font-medium">Password</span><input className="tg-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button className="tg-btn" type="submit">Continue</button>
        </form>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await authClient.twoFactor.verifyTotp({ code });
            if (r.error) return setError(r.error.message ?? 'invalid code');
            router.push('/admin/inbox');
          }}
        >
          <label className="block text-sm"><span className="font-medium">Authenticator code</span><input className="tg-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required /></label>
          <button className="tg-btn" type="submit">Verify</button>
        </form>
      )}
      {error ? <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p> : null}
    </main>
  );
}
