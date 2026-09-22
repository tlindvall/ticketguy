import type { Metadata } from 'next';
import './globals.css';
import { env } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

/** Dynamic so the public address tracks CONCIERGE_INBOUND_ADDRESS instead of being frozen at build time. */
export function generateMetadata(): Metadata {
  const address = env().CONCIERGE_INBOUND_ADDRESS;
  return {
    title: 'Ticket Guy — email your ticket guy',
    description: `Send a ticket link, screenshot, or description to ${address}. We check your options and link you to the seller.`,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const e = env();
  return (
    <html lang="en">
      <body>
        {e.APP_MODE === 'fixture' ? (
          <div role="status" className="bg-amber-100 px-4 py-1 text-center text-xs font-medium text-amber-900">
            FIXTURE MODE — synthetic data only; outbound email disabled
          </div>
        ) : null}
        {children}
      </body>
    </html>
  );
}
