import Link from 'next/link';
import { env } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

export default function HowItWorks() {
  const address = env().CONCIERGE_INBOUND_ADDRESS;
  return (
    <main className="tg-container prose prose-gray max-w-3xl">
      <h1 className="text-3xl font-bold">How Ticket Guy works</h1>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-gray-800">
        <li>You email <a href={`mailto:${address}`}>{address}</a> with a link, screenshot or description.</li>
        <li>We confirm the exact event, date, venue and how many seats you need. If something is unclear we ask up to three short questions.</li>
        <li>We check the sources we are permitted to check for that kind of event and record which ones we could and could not check.</li>
        <li>Deterministic rules compare whole-party totals including known fees; anything with unknown fees, taxes or seating is labeled as such—never counted as a saving.</li>
        <li>Where we have licensed history for comparable events, we say how today&apos;s price compares to what similar buyers could find. Where we don&apos;t, we say so.</li>
        <li>A person reviews every recommendation before it is sent. Buying happens with the seller.</li>
      </ol>
      <h2 className="mt-8 text-xl font-semibold">What we don&apos;t do</h2>
      <p className="mt-2 text-gray-800">No purchases, reservations, payments, ticket custody, seller logins, transfers, lottery entries or price predictions. We are not a marketplace.</p>
      <p className="mt-8 text-sm"><Link href="/">Back</Link></p>
    </main>
  );
}
