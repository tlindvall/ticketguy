import Link from 'next/link';
import type { LaunchState } from '@/lib/config/launch';
import { SvgLibrary } from '@/components/public/Landing';
import { HeroDemo } from './HeroDemo';
import { CopyAddress } from './CopyAddress';
import { SourceUniverse } from './SourceUniverse';
import { PixelCursor } from './PixelCursor';
import { FloatingGuy } from './FloatingGuy';
import { EventTypes } from './EventTypes';
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
 * Order: promise + composer (with its demo reply) → three things to ask → every kind of event (ticker) → how it works
 * → where the data comes from (source universe) → a second example (a catch) → FAQ → closing.
 *
 */
/** `preview` marks the page as the staff-only preview (a banner, and the logo links back to the preview). */
type Props = { state: LaunchState; address: string; preview?: boolean };

type Starter = { tone: 'cream' | 'navy' | 'gray'; subject: string; lines: string[]; shows: string; body: string };
const STARTERS: Starter[] = [
  {
    tone: 'navy',
    subject: 'Is $150 each for these Dua Lipa tickets a good price?',
    lines: ['Is $150 each for these', 'Dua Lipa tickets', 'a good price?'],
    shows: 'Check a price',
    body: 'Ticket link or screenshot:\nHow many tickets:\nAnything that matters (seats together, section, budget):\n',
  },
  {
    tone: 'cream',
    subject: 'Four Knicks tickets next Saturday. Under $600 total.',
    lines: ['Four Knicks tickets', 'next Saturday.', 'Under $600 total.'],
    shows: 'Find tickets',
    body: 'Where you’d like to sit (or “anywhere decent”):\nSeats together? Yes / no\nAnything else we should know:\n',
  },
  {
    tone: 'gray',
    subject: 'These seats look cheap. What’s the catch?',
    lines: ['These seats', 'look cheap.', 'What’s the catch?'],
    shows: 'Spot the catch',
    body: 'Ticket link or screenshot:\nHow many tickets:\nWhen you need them by:\n',
  },
];

const FAQ: Array<{ q: string; a: string }> = [
  { q: 'What does it cost?', a: 'Nothing. Ticket Guy is free. Some seller links pay us a commission if you buy, but that never decides what we recommend.' },
  { q: 'When will I hear back?', a: 'Usually within 5 minutes. If we need a detail, like how many tickets or your budget, we’ll ask.' },
  { q: 'What happens after I email?', a: 'We reply in the same email thread. If a detail is missing, we ask first; then you get the call, the total for your group and a link to the seller. Reply any time to follow up. Emailing us doesn’t sign you up for anything else.' },
  { q: 'Which events can you help with?', a: 'Live events across the US: pro and college sports, concerts, theater, comedy, festivals and more. Name the event, or send the listing you’re looking at.' },
  { q: 'Where do you cover?', a: 'The whole United States, coast to coast: big arenas, stadiums and theaters, and smaller local venues too.' },
  { q: 'Who replies?', a: 'Ticket Guy, an AI assistant built for one job: getting you the right tickets at the right price. It reads the listing you send, checks the event against live resale market data from the major marketplaces, including StubHub and Vivid Seats, and prices your whole group with fees. It tracks how prices are moving, so it can tell you when to buy and when to wait. Our team oversees it and steps in when a request needs a person.' },
  { q: 'How do you make money?', a: 'Ticket Guy is always free for you. With some ticket sellers we’re an affiliate: if you buy through our link, the seller pays us a commission. It never decides what we recommend.' },
  { q: 'Can you guarantee the lowest price, or that tickets are valid?', a: 'No. We compare what sellers are listing and tell you what to check: the total with fees, where the seats are, and when the tickets arrive. You buy from the seller, and the seller is responsible for the tickets, delivery and refunds.' },
];

export function InboxHome({ state, address, preview = false }: Props) {
  const live = state === 'live';
  // The visitor's own subject is sent as written; only the plain address links carry a default subject.
  const general = live ? 'Tickets' : 'Ticket Guy early access';
  const mailto = (subject: string, body?: string) => `mailto:${address}?subject=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
  const cta = live ? 'Ask your ticket guy' : 'Email for early access';
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
            <p className="mono-note hero-note">Free. No app. A reply in minutes.</p>
            <p className="hero-alt">Don’t have tickets in mind? <a href={mailto('Looking for tickets', 'What you’d like to see:\nWhen and where:\nHow many tickets, and your budget:\n')}>Tell me what you’re looking for ›</a></p>
          </div>
          <HeroDemo address={address} cta={cta} />
        </section>


        <section className="starters wrap" aria-labelledby="starters-title">
          <div className="section-head">
            <h2 id="starters-title">Three things to ask your guy.</h2>
            <p>Choose one to open a draft in your email app. <CopyAddress address={address} className="inline-copy" label="Or copy the address" /></p>
          </div>
          <ul className="starter-grid">
            {STARTERS.map((s) => (
              <li key={s.subject}>
                <a className={`starter starter-${s.tone}`} href={mailto(s.subject, s.body)} aria-label={`Start an email: ${s.subject}`}>
                  <span className="starter-titlebar">New message</span>
                  <span className="starter-to"><span className="mono">To:</span> <span className="starter-address">{address}</span></span>
                  <svg className="starter-mark" aria-hidden="true"><use href="#ticket-mark" /></svg>
                  <span className="starter-subject">
                    <span className="mono">Subject:</span>
                    {s.lines.map((l) => <span key={l} className="starter-line">{l}</span>)}
                  </span>
                  <span className="starter-footer">
                    <span>{s.shows}</span>
                    <span className={s.tone === 'navy' ? 'btn-lime btn-small' : 'btn-plain btn-small'}>Start an email <span aria-hidden="true">›</span></span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <EventTypes />

        <section id="how-it-works" className="how wrap" aria-labelledby="how-title">
          <h2 id="how-title">One email. A better call.</h2>
          <ol className="steps3">
            <li className="step3">
              <span className="step3-num" aria-hidden="true">1</span>
              <div className="step3-win">
                <div className="step3-bar"><EnvelopeIcon /> New message</div>
                <div className="step3-body">
                  <h3>Send your request.</h3>
                  <p>A ticket link, a screenshot, or a few words about your plans.</p>
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
                  <h3>Get a straight answer.</h3>
                  <p>The call, the total for your group, and anything worth knowing before you buy.</p>
                  <div className="step3-demo"><span className="step3-call">Buy now, or hold off.</span></div>
                </div>
              </div>
              <PixelCursor className="step3-arrow" />
            </li>
            <li className="step3">
              <span className="step3-num" aria-hidden="true">3</span>
              <div className="step3-win">
                <div className="step3-bar"><PaperclipIcon /> Seller’s listing</div>
                <div className="step3-body">
                  <h3>You buy direct.</h3>
                  <p>A link to the seller. The decision is always yours.</p>
                  <div className="step3-demo"><span className="link">View the seller’s listing ↗</span></div>
                </div>
              </div>
            </li>
          </ol>
          <div className="independence">
            <p className="independence-line">Advice across ticket sellers, with your budget and plans in mind. You buy directly from the seller.</p>
            <p className="mono-note">Some seller links pay us a commission. It never decides what we recommend. We never buy, hold or resell tickets.</p>
          </div>
        </section>

        <SourceUniverse />

        <section className="catch wrap" aria-labelledby="catch-title">
          <div className="section-head">
            <h2 id="catch-title">Cheap for a reason?</h2>
            <p>Spotting the catch before you pay.</p>
          </div>
          <article className="catch-mail" aria-label="Ticket Guy’s reply, spotting the catch">
            <div className="reply-titlebar"><span>Re: These seats look cheap. What’s the catch?</span><span className="reply-flag">Replied in 3 min</span></div>
            <p className="catch-asked"><span className="mono">You asked:</span> Two in Section 112 for $95 each. Seems low?</p>
            <div className="catch-body">
              <p className="catch-call">Two catches.</p>
              <ul className="catch-list">
                <li><span className="catch-label">Delivery</span> The seller sends the tickets 24 hours before the show, not now.</li>
                <li><span className="catch-label">View</span> Listed as limited view, behind the sound desk.</li>
              </ul>
              <p className="catch-next">If you’re fine with both, $95 is fair for that section. If you’re travelling in or want a clear view, I’d skip these.</p>
            </div>
          </article>
        </section>

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
          <div className="wrap">
            <h2 id="closing-title">{live ? 'Already looking at tickets? Send them over.' : 'Before you buy, ask your guy.'}</h2>
            <a className="closing-address" href={mailto(general)}>{address}</a>
            <p>{live ? 'Free. Usually a reply within 5 minutes.' : 'Email for early access.'}</p>
          </div>
        </section>
      </main>

      <FloatingGuy />

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
