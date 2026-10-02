import Link from 'next/link';
import type { LaunchState } from '@/lib/config/launch';
import { SvgLibrary } from '@/components/public/Landing';
import { HeroDemo } from './HeroDemo';
import { TrustSection } from './TrustSection';
import { PixelCursor } from './PixelCursor';
import { Proof } from './Proof';
import { AddressBook, vcardHref } from './AddressBook';
import { CopyAddress } from './CopyAddress';
import { EnvelopeIcon, PaperclipIcon, ReplyIcon } from './icons';
import './inbox.css';

/**
 * Brand direction 01, "Your guy in the inbox": the homepage (docs/brand/y2k-01), also shown at /preview/home.
 * Email is the way in, so the page is built from email parts: one working compose window as the hero, an
 * example reply, subject lines that start a draft, and the address as the brand. Every example opens a draft
 * in the visitor's own email app (nothing is sent until they press send), with copy-address as the fallback.
 *
 * The composer plays its own short demonstration (HeroDemo): the request types itself, the button is
 * pressed, and the reply arrives with the call. It stays a working composer throughout.
 *
 * Order: promise + the one action (Email your ticket guy) beside the labelled example conversation → one proof exchange →
 * how it works → your side of the market (principles; the source map is on /sources) → FAQ → closing with the
 * address-book card. Claims follow the service-depth policy: no unmeasured reply times, examples
 * labelled, market data described as context, listing facts attributed to the listing.
 *
 */
/** `preview` marks the page as the staff-only preview (a banner, and the logo links back to the preview). */
type Props = { state: LaunchState; address: string; preview?: boolean };


const FAQ: Array<{ q: string; a: string }> = [
  { q: 'What does it cost?', a: 'Nothing. Ticket Guy is free. With some sellers we’re an affiliate: if you buy through our link, the seller pays us a commission. That never decides what we recommend.' },
  { q: 'What happens after I email?', a: 'Replies arrive in the same email thread. If a detail is missing, we ask first. Reply any time to follow up. Emailing us doesn’t sign you up for anything else.' },
  { q: 'Which events can you help with?', a: 'Concerts and major sports across the US are our focus. For other US events, send the details and we’ll tell you how much we can help.' },
  { q: 'Can you tell me whether to buy now or wait?', a: 'When there’s enough comparable price history, yes: how prices are moving and what I’d do. A fall in the cheapest single ticket doesn’t always help a group that wants to sit together, and if the evidence is thin, I’ll say so.' },
  { q: 'Who replies?', a: 'Ticket Guy is an AI ticket assistant overseen by our team. It works from your request, what the listing says and available market data. If something hasn’t been verified, the reply says so.' },
  { q: 'Can you guarantee the price, or that tickets are valid?', a: 'No. I read what the listing says and tell you what to confirm: the total with fees, where the seats are and when the tickets arrive. You buy from the seller, and the seller is responsible for the tickets, delivery and refunds.' },
];

export function InboxHome({ state, address, preview = false }: Props) {
  const live = state === 'live';
  // The visitor's own subject is sent as written; only the plain address links carry a default subject.
  const general = live ? 'Tickets' : 'Ticket Guy early access';
  const mailto = (subject: string, body?: string) => `mailto:${address}?subject=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
  const cta = live ? 'Email your ticket guy' : 'Email for early access';
  return (
    <div className="tgx">
      <SvgLibrary />
      <a className="skip-link" href="#main">Skip to content</a>
      {preview ? <p className="preview-flag">Preview of brand direction 01. Not the live site.</p> : null}
      <header className="tgx-header wrap">
        <Link className="brand" href={preview ? '/preview/home' : '/'} aria-label="Ticket Guy home">
          <svg className="brand-mark" aria-hidden="true"><use href="#ticket-mark" /></svg>
          <span>ticket guy</span>
        </Link>
        <nav aria-label="Main navigation">
          <a className="nav-how" href="#how-it-works">How it works</a>
          <a className="nav-how" href="#faq">FAQ</a>
          <span className="status">{live ? 'Now in beta' : 'Coming soon'}</span>
          <a className="link" href={mailto(general)}>{address}</a>
        </nav>
      </header>

      <main id="main">
        <section className="hero wrap" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">You’ve finally got a ticket guy.</h1>
            <p className="hero-lede">Found tickets? Get a second opinion before you buy.</p>
            <p className="hero-focus">Independent ticket advice for concerts and major sports across the US.</p>
            <div className="hero-cta">
              <a className="btn-lime btn-big" href={mailto(general)}>{cta} <span aria-hidden="true">›</span></a>
              <CopyAddress address={address} />
            </div>
            <p className="mono-note hero-note">Free. No app. Just email <a href={mailto(general)}>{address}</a>.</p>
            <p className="hero-alt">Don’t have tickets in mind? <a href={mailto('Looking for tickets', 'Artist, team or event:\nCity or venue, and date:\nHow many tickets (optional):\n')}>Tell me what you’re looking for ›</a></p>
            <p className="hero-save"><a href={vcardHref(address)} download="ticket-guy.vcf"><span className="abook-icon" aria-hidden="true" />Save your ticket guy to your contacts</a></p>
          </div>
          <HeroDemo address={address} />
        </section>


        <Proof mailto={mailto(general)} />

        <section id="how-it-works" className="how wrap" aria-labelledby="how-title">
          <h2 id="how-title">One email. A better call.</h2>
          <ol className="steps3">
            <li className="step3">
              <span className="step3-num" aria-hidden="true">1</span>
              <div className="step3-win">
                <div className="step3-bar"><EnvelopeIcon /> New message</div>
                <div className="step3-body">
                  <h3>Send what you’re looking at.</h3>
                  <p>A link, a screenshot or a few words about the event and what matters to you.</p>
                  <div className="step3-demo">
                    <span className="mono">To: {address}</span>
                    <span className="step3-send">Send ›<PixelCursor className="step3-click" /></span>
                  </div>
                </div>
              </div>
              <PixelCursor className="step3-arrow" />
            </li>
            <li className="step3">
              <span className="step3-num" aria-hidden="true">2</span>
              <div className="step3-win">
                <div className="step3-bar"><ReplyIcon /> Re: your tickets</div>
                <div className="step3-body">
                  <h3>Get a useful second opinion.</h3>
                  <p>What the price includes, catches worth checking and how the options stack up. With useful price history, what it suggests about timing.</p>
                  <div className="step3-demo"><span className="step3-call">What it costs. What to check.</span></div>
                </div>
              </div>
              <PixelCursor className="step3-arrow" />
            </li>
            <li className="step3">
              <span className="step3-num" aria-hidden="true">3</span>
              <div className="step3-win">
                <div className="step3-bar"><PaperclipIcon /> Seller’s page</div>
                <div className="step3-body">
                  <h3>You buy directly from the seller.</h3>
                  <p>I’ll point you to the listing or the official booking page. You make the call.</p>
                  <div className="step3-demo"><span className="link">Go to the seller ↗</span></div>
                </div>
              </div>
            </li>
          </ol>
        </section>

        <TrustSection />

        <section id="faq" className="faq wrap" aria-labelledby="faq-title">
          <h2 id="faq-title">Before you send.</h2>
          <div className="faq-list">
            {FAQ.map((f) => (
              <details key={f.q} name="faq">
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <div className="wrap closing-grid">
            <div>
              <h2 id="closing-title">{live ? 'Already looking at tickets? Send them over.' : 'Before you buy, ask your guy.'}</h2>
              <a className="closing-address" href={mailto(general)}>{address}</a>
              <p>{live ? 'Free. Replies arrive in the same email thread.' : 'Email for early access.'} <CopyAddress address={address} className="closing-copy" /></p>
            </div>
            <AddressBook address={address} />
          </div>
        </section>
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
