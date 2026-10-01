import Link from 'next/link';

/**
 * "Your side of the ticket market": the principles behind every reply, and one plain line on what the advice
 * rests on. The full source map, with what each source is and is not, lives on /sources.
 */
export function TrustSection() {
  return (
    <section className="trust wrap" aria-labelledby="trust-title">
      <h2 id="trust-title">Your side of the ticket market.</h2>
      <ul className="principles">
        <li><strong>Your budget and plans drive the call.</strong> Not the seller, not the listing.</li>
        <li><strong>Commission never does.</strong> Some seller links pay us; they don’t change what we recommend.</li>
        <li><strong>If we’re not sure, we say so.</strong> I’ll tell you what I checked, and what’s still unconfirmed.</li>
      </ul>
      <p className="trust-how">Your request, the listing you send and available market data shape the advice. <Link className="link" href="/sources">Where our information comes from ›</Link></p>
      <p className="trust-note">You buy directly from the seller. We never buy, hold or resell tickets.</p>
    </section>
  );
}
