import Link from 'next/link';
import type { LaunchState } from '@/lib/config/launch';
import { SvgLibrary } from '@/components/public/Landing';
import { HeroDemo } from './HeroDemo';
import { CopyAddress } from './CopyAddress';
import { HeroVideo } from './HeroVideo';
import { SourceUniverse } from './SourceUniverse';
import { PixelCursor } from './PixelCursor';
import { FloatingGuy } from './FloatingGuy';
import { EnvelopeIcon, PaperclipIcon, ReplyIcon } from './icons';
import './inbox.css';

/**
 * Brand direction 01, "Your guy in the inbox": the homepage (docs/brand/y2k-01), also shown at /preview/home.
 * Email is the way in, so the page is built from email parts: one working compose window as the hero, an
 * example reply, subject lines that start a draft, and the address as the brand. Every example opens a draft
 * in the visitor's own email app (nothing is sent until they press send), with copy-address as the fallback.
 *
 * The composer plays its own short demonstration (HeroDemo): the request types itself, the button is
 * pressed, and an illustrative reply arrives with the call. It stays a working composer throughout.
 *
 * Order: promise + composer → example reply → request starters → source universe → how it works → demo animation → FAQ →
 * closing invitation. The animation is an optional demonstration lower down; the headline and the composer
 * carry the first screen on their own.
 *
 * The example reply is labelled illustrative until there is an anonymized real exchange to use with permission.
 */
/** `preview` marks the page as the staff-only preview (a banner, and the logo links back to the preview). */
type Props = { state: LaunchState; address: string; preview?: boolean };

type Starter = { tone: 'cream' | 'navy' | 'gray'; subject: string; lines: string[]; shows: string; body: string };
const STARTERS: Starter[] = [
  {
    tone: 'cream',
    subject: 'Is $150 each for these Dua Lipa tickets a good price?',
    lines: ['Is $150 each for these', 'Dua Lipa tickets', 'a good price?'],
    shows: 'Check a price',
    body: 'Ticket link or screenshot:\nHow many tickets:\nAnything that matters (seats together, section, budget):\n',
  },
  {
    tone: 'navy',
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
            <h1 id="hero-title">You’ve finally got a ticket guy now.</h1>
            <p className="hero-lede">Found tickets? Get a second opinion before you buy.</p>
            <p className="hero-sub">Send a link, a screenshot, or tell us what you’re looking for. We’ll check the price, flag important catches, and look for better options.</p>
            <p className="hero-address">
              <a className="link" href={mailto(general)}>{address}</a>
            </p>
            <p className="mono-note">Free. Usually a reply within 5 minutes.<br />No app. No account. Just email.</p>
          </div>
          <HeroDemo address={address} cta={cta} />
        </section>

        <section className="example wrap" aria-labelledby="example-title">
          <div className="section-head">
            <h2 id="example-title">What you get back.</h2>
            <p>A straight answer, the real total, and what to watch for.</p>
          </div>
          <article className="reply" aria-label="Illustrative example of a Ticket Guy reply, not a live offer">
            <div className="reply-titlebar"><span>Re: Knicks next Saturday</span><span className="reply-flag">Illustrative example</span></div>
            <dl className="reply-meta">
              <div><dt>From:</dt><dd>Ticket Guy &lt;{address}&gt;</dd></div>
              <div><dt>You asked:</dt><dd>Four of us. Under $150 each. Can you find something decent?</dd></div>
            </dl>
            <div className="reply-body">
              <p className="reply-call">I’d buy these.</p>
              <div className="reply-offer">
                <div>
                  <strong>Section 224, Row 6, Seats 5–8</strong>
                  <span>Four seats together, side by side</span>
                </div>
                <div className="reply-total">
                  <strong>$548 total</strong>
                  <span>$137 each, fees included</span>
                </div>
              </div>
              <p className="reply-watch"><span className="mono">Worth knowing:</span> mobile transfer, and the seller says the tickets arrive 48 hours before tip-off. If you’re travelling in, that’s in time.</p>
              <p className="reply-note">That’s under your budget, and it’s the cheapest listing I found with all four seats together. Group prices have dipped a little this week.</p>
              <span className="link reply-link">View the seller’s listing <span aria-hidden="true">↗</span><span className="sr-only"> (illustrative, no live listing)</span></span>
            </div>
          </article>
        </section>

        <section className="starters wrap" aria-labelledby="starters-title">
          <div className="section-head">
            <h2 id="starters-title">Start with a subject line.</h2>
            <p>Tap one to start a draft in your email app. Nothing is sent until you press send. Email app not opening? <CopyAddress address={address} className="inline-copy" label={`Copy ${address}`} /></p>
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

        <SourceUniverse />

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

        <section className="demo wrap" aria-labelledby="demo-title">
          <div className="section-head">
            <h2 id="demo-title">See one request, start to finish.</h2>
            <p>An illustrative example, in 20 seconds.</p>
          </div>
          <HeroVideo />
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
            <h2 id="closing-title">{live ? 'Got tickets in mind? Give us a try.' : 'Before you buy, ask your guy.'}</h2>
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
