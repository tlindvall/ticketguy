'use client';
import { useState } from 'react';

export function UnsubscribeButton({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  return done ? (
    <p role="status" className="mt-4 text-gray-800">You&apos;re unsubscribed from ticket offers. Replies to your own requests are unaffected.</p>
  ) : (
    <button
      className="tg-btn mt-4"
      onClick={async () => {
        await fetch(`/api/unsubscribe/one-click/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
        setDone(true);
      }}
    >
      Unsubscribe from ticket offers
    </button>
  );
}
