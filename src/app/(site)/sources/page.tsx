import type { Metadata } from 'next';
import Link from 'next/link';
import { SvgLibrary } from '@/components/public/Landing';
import { SourceUniverse } from '@/components/preview/SourceUniverse';
import '@/components/preview/inbox.css';

export const metadata: Metadata = {
  title: 'Ticket Guy — Where our information comes from',
  description: 'Market data, the listing you send, and the US ticket sellers and official booking pages we know: what each one is, and what it is not.',
};

export default function SourcesPage() {
  return (
    <div className="tgx">
      <SvgLibrary />
      <header className="tgx-header wrap">
        <Link className="brand" href="/" aria-label="Ticket Guy home">
          <svg className="brand-mark" aria-hidden="true"><use href="#ticket-mark" /></svg>
          <span>ticket guy</span>
        </Link>
        <nav aria-label="Main navigation"><Link className="link" href="/">Back to Ticket Guy</Link></nav>
      </header>
      <main id="main">
        <SourceUniverse />
      </main>
      <footer className="tgx-footer wrap">
        <p>Prices and availability can change.</p>
        <nav aria-label="Legal">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </footer>
    </div>
  );
}
