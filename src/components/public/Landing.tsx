import Link from 'next/link';
import type { LaunchState } from '@/lib/config/launch';
import './landing.css';

/**
 * The public landing page: the owner's design (ticket-guy-landing-page/index.html + styles.css), ported
 * to JSX with its structure, copy and SVG symbols preserved. Styles live in landing.css, scoped under
 * .tg-landing so they cannot reach the admin console.
 *
 * The design is pre-launch. Its handoff asks that the status, the early-access calls to action and
 * subjects, and the footer preview label change at launch; they follow launchState, so clearing the
 * recipient allowlist (the actual launch) switches them and nothing else.
 */
type Props = { state: LaunchState; address: string };

const IDEAS: Array<{ label: string; text: string }> = [
  { label: 'Find me tickets', text: 'Hey, I need Knicks tickets for next Saturday.' },
  { label: 'Check a price', text: 'Is $50 for a Dua Lipa ticket a good price?' },
  { label: 'Help me decide', text: 'Should I buy these now, or wait? Here’s the link.' },
  { label: 'Keep us together', text: 'Can you find five seats together for the Rangers, under $100 each?' },
];

export function Landing({ state, address }: Props) {
  const live = state === 'live';
  const mailto = (subject: string, body?: string) => `mailto:${address}?subject=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
  const mainSubject = live ? 'Tickets' : 'Ticket Guy early access';
  const ideaSubject = live ? 'Ticket request' : 'Ticket Guy early access — example request';

  return (
    <div className="tg-landing">
      <SvgLibrary />
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header container">
        <Link className="brand" href="/" aria-label="Ticket Guy home">
          <svg className="brand-mark" aria-hidden="true"><use href="#ticket-mark" /></svg>
          <span>ticket guy</span>
        </Link>
        <span className="brand-description">Independent ticket advice</span>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <span className="status">{live ? 'Now open' : 'Coming soon'}</span>
        </nav>
      </header>
      <main id="main">
        <section className="hero container" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">
              Good tickets.
              <br />
              <span className="highlight">Better</span> advice.
            </h1>
            <p className="hero-description">Send a link, a screenshot, or tell us what you want. We’ll compare the options and help you decide: buy now or hold off.</p>
            <a className="button" href={mailto(mainSubject)}>
              {live ? 'Email your ticket guy' : 'Get early access'} <span aria-hidden="true">↗</span>
            </a>
            <a className="email-address" href={mailto(mainSubject)}>Email {address}</a>
            <p className="microcopy">No app. No account. Just email.</p>
          </div>
          <div className="example-wrap">
            <article className="email-example" aria-label="Illustrative Ticket Guy email conversation, not a live offer">
              <div className="example-label">Illustrative example · Not a live offer</div>
              <div className="email-content">
                <div className="message customer-message">
                  <div className="avatar" aria-hidden="true">Y</div>
                  <div>
                    <p className="sender">You</p>
                    <p>Five together for a Rangers preseason game. Under $100 each.</p>
                  </div>
                </div>
                <div className="reply-header">
                  <div className="avatar avatar-ticket">
                    <svg aria-hidden="true"><use href="#ticket-mark" /></svg>
                  </div>
                  <div>
                    <p className="sender">Ticket Guy</p>
                    <h2>For your group, I’d buy these.</h2>
                  </div>
                </div>
                <div className="offer">
                  <div>
                    <strong>Madison Square Garden</strong>
                    <span>Five seats together</span>
                  </div>
                  <div className="offer-price">
                    <strong>$425 total</strong>
                    <span>Fees included</span>
                  </div>
                </div>
                <dl className="price-context">
                  <div>
                    <dt>Typical range</dt>
                    <dd>$75–$95 per seat*</dd>
                  </div>
                  <div>
                    <dt>Last 24 hours</dt>
                    <dd>Group price down 8%</dd>
                  </div>
                </dl>
                <p className="reply-body">At $85 each, this is a fair price. Singles are cheaper, but five together is a different search. Since sitting together matters most, I’d take these.</p>
                <span className="example-link">
                  View seller’s listing <span aria-hidden="true">↗</span>
                  <span className="sr-only"> — illustrative only, no live listing</span>
                </span>
                <p className="example-note">*Comparable preseason games in this seating zone. All figures are illustrative.</p>
              </div>
            </article>
            <svg className="mascot" aria-hidden="true"><use href="#ticket-friend" /></svg>
          </div>
        </section>
        <div className="category-divider container" aria-label="Sports, concerts and shows across the US">
          <span>
            Sports <b>/</b> Concerts <b>/</b> Shows <b>/</b> Across the U.S.
          </span>
        </div>
        <section className="request-ideas container" aria-labelledby="ideas-title">
          <div className="ideas-heading">
            <h2 id="ideas-title">What can I ask?</h2>
            <p>Start with what you know. We’ll ask for any missing details.</p>
          </div>
          <ul className="idea-list">
            {IDEAS.map((idea) => (
              <li key={idea.label}>
                <a href={mailto(ideaSubject, idea.text)}>
                  <span className="idea-label">{idea.label}</span>
                  <span className="idea-text">“{idea.text}”</span>
                  <span className="idea-arrow" aria-hidden="true">↗</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="ideas-note">{live ? 'Tap an example to draft an email. Nothing is sent until you press send.' : 'Tap an example to draft an email. Coming soon—these are early-access requests.'}</p>
        </section>
        <section id="how-it-works" className="how-it-works container" aria-labelledby="how-title">
          <h2 id="how-title">One email. A better call.</h2>
          <ol className="steps">
            <li>
              <span className="step-number" aria-hidden="true">01</span>
              <h3>Send your request.</h3>
              <p>A ticket link, a screenshot, or a few words about your plans.</p>
            </li>
            <li>
              <span className="step-number" aria-hidden="true">02</span>
              <h3>Get the full picture.</h3>
              <p>Suitable seats, real totals, and price history where available.</p>
            </li>
            <li>
              <span className="step-number" aria-hidden="true">03</span>
              <h3>You buy direct.</h3>
              <p>Get a recommendation and a link to the seller. The decision is yours.</p>
            </li>
          </ol>
          <p className="trust-note">AI-assisted. Human-reviewed. No tickets bought or resold by us.</p>
        </section>
        <section className="closing" aria-labelledby="closing-title">
          <div className="container">
            <h2 id="closing-title">Before you buy, ask your guy.</h2>
            <a href={mailto(mainSubject)}>{address}</a>
            <p>{live ? 'Email us your plans.' : 'Email for early access.'}</p>
          </div>
        </section>
      </main>
      <footer className="site-footer container">
        <p>Prices and availability can change.</p>
        <nav aria-label="Legal">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          {live ? null : <span>Concept preview</span>}
        </nav>
      </footer>
    </div>
  );
}

/** The ticket mark and the mascot from the design, defined once and referenced with <use>. */
function SvgLibrary() {
  return (
    <svg className="svg-library" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <symbol id="ticket-mark" viewBox="0 0 80 60">
          <path d="M8 8H72V19C59 19 59 41 72 41V52H8V41C21 41 21 19 8 19Z" fill="currentColor" stroke="#142438" strokeWidth="4" strokeLinejoin="round" />
          <ellipse cx="32" cy="30" rx="6" ry="10" fill="#142438" />
          <ellipse cx="49" cy="30" rx="6" ry="10" fill="#142438" />
          <ellipse cx="34" cy="26" rx="2" ry="4" fill="#fff" />
          <ellipse cx="51" cy="26" rx="2" ry="4" fill="#fff" />
        </symbol>
        <symbol id="ticket-friend" viewBox="0 0 128 160">
          <g fill="none" stroke="#142438" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M33 83L17 100L29 108M93 88L106 99L111 86M49 131L46 148H35M77 132L81 149H93" />
            <path d="M34 17L97 29L94 43Q79 40 77 55Q75 69 89 72L77 136L14 124L26 61Q40 64 43 50Q46 36 31 32Z" fill="#d7f36b" />
            <path d="M40 99Q52 114 66 101M110 55L121 51M113 66L125 67M108 77L118 83" />
          </g>
          <ellipse cx="49" cy="76" rx="5" ry="9" fill="#142438" transform="rotate(12 49 76)" />
          <ellipse cx="67" cy="80" rx="5" ry="9" fill="#142438" transform="rotate(12 67 80)" />
        </symbol>
      </defs>
    </svg>
  );
}
