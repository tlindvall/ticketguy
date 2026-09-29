import Link from 'next/link';

export default function Terms() {
  return (
    <main className="tg-container">
      <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>Draft — requires owner/legal review before launch.</strong>
      </div>
      <h1 className="text-3xl font-bold">Terms (draft)</h1>
      <div className="mt-4 space-y-3 text-gray-800">
        <p>Ticket Guy is an independent information service. We compare publicly offered tickets and link you to the seller. Any purchase is a contract between you and the seller; their terms, fees, delivery and refund policies apply.</p>
        <p>Prices and availability change. Every recommendation states when it was checked; we do not guarantee that an offer is still available or unchanged when you reach checkout.</p>
        <p>Where a link includes referral tracking we disclose it next to the link. Referral compensation never influences which offers we show or how we rank them.</p>
        <p>We do not provide price forecasts or guarantees about future prices. Buy/wait guidance describes evidence and trade-offs; the decision is yours.</p>
        <p>US customers and US events only during the pilot.</p>
      </div>
      <p className="mt-8 text-sm"><Link href="/">Back</Link></p>
    </main>
  );
}
