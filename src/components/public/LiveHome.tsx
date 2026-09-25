import Link from 'next/link';
import { env } from '@/lib/config/env';

/** The public home once strangers can email the concierge and get a reply (see launchState). */
export function LiveHome() {
  const e = env();
  const addr = e.CONCIERGE_INBOUND_ADDRESS;
  return (
    <main className="tg-container">
      <header className="mb-10">
        <p className="text-sm font-semibold uppercase tracking-wide text-teal-700">Ticket Guy</p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">Email your ticket guy.</h1>
        <p className="mt-4 text-lg text-gray-700">Send what you&apos;re considering—or what you want to see—and we&apos;ll check your options.</p>
        <a className="tg-btn mt-6" href={`mailto:${addr}?subject=Tickets`}>
          Email {addr}
        </a>
      </header>
      <section className="grid gap-6 sm:grid-cols-3">
        <div>
          <h2 className="font-semibold">Send a link</h2>
          <p className="mt-1 text-sm text-gray-700">Paste the listing you&apos;re looking at. We compare it against suitable alternatives for the same seats and quantity.</p>
        </div>
        <div>
          <h2 className="font-semibold">Send a screenshot</h2>
          <p className="mt-1 text-sm text-gray-700">JPEG, PNG or WebP. We read the event, seats and price you were quoted. Leave out barcodes and payment details.</p>
        </div>
        <div>
          <h2 className="font-semibold">Describe it</h2>
          <p className="mt-1 text-sm text-gray-700">&ldquo;Five together for the Rangers on Oct 3, $450 total, we have to go.&rdquo; Tell us what matters: together, budget, must-attend.</p>
        </div>
      </section>
      <section className="mt-10 rounded-md border border-gray-200 p-4 text-sm text-gray-700">
        <p>
          <strong>Where we work:</strong> US customers and US events. The pilot focuses on {e.pilotSupportedCategories.map((c) => c.toUpperCase()).join(', ')} events in the {e.pilotSupportedMarkets.join(', ')} area; other US requests go to a person and may take longer.
        </p>
        <p className="mt-2">
          <strong>How it works:</strong> Ticket Guy is AI-assisted and human-reviewed. We compare offers and link you to the seller. We never buy, hold or resell tickets, and we do not add you to any mailing list unless you ask.
        </p>
      </section>
      <footer className="mt-10 flex gap-4 text-sm text-gray-600">
        <Link href="/how-it-works">How it works</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
      </footer>
    </main>
  );
}
