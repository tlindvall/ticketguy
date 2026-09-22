import { UnsubscribeButton } from '@/components/UnsubscribeButton';

export const dynamic = 'force-dynamic';

/** GET shows a confirm button only; the mutation is the POST (RFC 8058). Link scanners cannot unsubscribe by visiting. */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="tg-container">
      <h1 className="text-2xl font-bold">Unsubscribe from ticket offers</h1>
      <p className="mt-2 text-gray-700">Confirm below to stop promotional emails. You will still receive replies to requests you send us.</p>
      <UnsubscribeButton token={token} />
    </main>
  );
}
