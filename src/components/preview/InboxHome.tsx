import Link from 'next/link';
import type { LaunchState } from '@/lib/config/launch';
import { SvgLibrary } from '@/components/public/Landing';
import { ComposeDemo } from './ComposeDemo';
import { EnvelopeIcon, PaperclipIcon, ReplyIcon } from './icons';
import './inbox.css';

/**
 * Brand direction 01, "Your guy in the inbox": the homepage as a preview (docs/brand/y2k-01). Email is the
 * way in, so the page is built from email parts: a working compose window, subject lines that start a
 * draft, and the address as the brand. It keeps what the live page does: the launch state sets the calls
 * to action and subjects, every example opens a draft (nothing is sent until the visitor sends it), and
 * the legal links stay. The ticket mark and mascot are the existing SVGs from the live page.
 *
 * Left out on purpose (README production notes): window controls, an Events page we don't have, and
 * figures, prices or review claims that would read as real.
 */
type Props = { state: LaunchState; address: string };

type Starter = { tone: 'cream' | 'navy' | 'gray'; titlebar: string; subject: string; lines: string[]; footer: 'cta' | 'ask' | 'address' };
const STARTERS: Starter[] = [
  { tone: 'cream', titlebar: 'New message', subject: 'Two seats. One anniversary. Help.', lines: ['Two seats.', 'One anniversary.', 'Help.'], footer: 'cta' },
  { tone: 'navy', titlebar: 'New message', subject: 'Is $150 a good price?', lines: ['Is $150', 'a good price?'], footer: 'ask' },
  { tone: 'gray', titlebar: 'Fwd: Tickets I found', subject: 'Fwd: Tickets I found', lines: ['Before you buy,', 'forward it to your guy.'], footer: 'address' },
];

export function InboxHome({ state, address }: Props) {
  const live = state === 'live';
  // The visitor's own subject is sent as written; only the plain address links carry the pre-launch subject.
  const general = live ? 'Tickets' : 'Ticket Guy early access';
  const mailto = (subject: string) => `mailto:${address}?subject=${encodeURIComponent(subject)}`;
  return (
    <div className="tgx">
      <SvgLibrary />
      <a className="skip-link" href="#main">Skip to content</a>
      <p className="preview-flag">Preview of brand direction 01. Not the live site.</p>
      <header className="tgx-header wrap">
        <Link className="brand" href="/preview/home" aria-label="Ticket Guy home">
          <svg className="brand-mark" aria-hidden="true"><use href="#ticket-mark" /></svg>
          <span>ticket guy</span>
        </Link>
        <nav aria-label="Main navigation">
          <a className="nav-how" href="#how-it-works">How it works</a>
          {live ? null : <span className="status">Coming soon</span>}
          <a className="link" href={mailto(general)}>{address}</a>
        </nav>
      </header>

      <main id="main">
        <section className="hero wrap" aria-labelledby="hero-title">
          <h1 id="hero-title">You’ve got a ticket guy.</h1>
          <p className="hero-sub">Send the link. Ask the question. Tell me what you’re after.</p>
          <div className="hero-demo">
            <ComposeDemo address={address} subject="Knicks next Saturday" body={'Four of us. Under $150 each.\nCan you find something decent?'} cta={live ? 'Email your ticket guy' : 'Email for early access'} />
            <svg className="mascot" aria-hidden="true"><use href="#ticket-friend" /></svg>
          </div>
          <p className="mono-note">No app. No account. Just email.</p>
        </section>

        <section className="starters wrap" aria-labelledby="starters-title">
          <div className="section-head">
            <h2 id="starters-title">Start with a subject line.</h2>
            <p>Tap one to start a draft. Nothing is sent until you press send.</p>
          </div>
          <ul className="starter-grid">
            {STARTERS.map((s) => (
              <li key={s.subject}>
                <a className={`starter starter-${s.tone}`} href={mailto(s.subject)} aria-label={`Start an email: ${s.subject}`}>
                  <span className="starter-titlebar">{s.titlebar}</span>
                  <span className="starter-to"><span className="mono">To:</span> <span className="starter-address">{address}</span></span>
                  <svg className="starter-mark" aria-hidden="true"><use href="#ticket-mark" /></svg>
                  <span className="starter-subject">
                    <span className="mono">Subject:</span>
                    {s.lines.map((l) => <span key={l} className="starter-line">{l}</span>)}
                  </span>
                  <span className="starter-footer">
                    <span>{s.footer === 'cta' ? 'Email your ticket guy.' : s.footer === 'ask' ? 'Ask before you buy.' : address}</span>
                    <span className={s.tone === 'navy' ? 'btn-lime btn-small' : 'btn-plain btn-small'}>Send <span aria-hidden="true">›</span></span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section id="how-it-works" className="how wrap" aria-labelledby="how-title">
          <h2 id="how-title">One email. A better call.</h2>
          <ol className="steps">
            <li>
              <EnvelopeIcon className="step-icon" />
              <h3>Send your request.</h3>
              <p>A ticket link, a screenshot, or a few words about your plans.</p>
            </li>
            <li>
              <ReplyIcon className="step-icon" />
              <h3>Get a straight answer.</h3>
              <p>Suitable seats, real totals, and price history where available.</p>
            </li>
            <li>
              <PaperclipIcon className="step-icon" />
              <h3>You buy direct.</h3>
              <p>A recommendation and a link to the seller. The decision is yours.</p>
            </li>
          </ol>
          <p className="mono-note">AI-assisted. We never buy, hold or resell tickets.</p>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <div className="wrap">
            <h2 id="closing-title">Before you buy, ask your guy.</h2>
            <a className="closing-address" href={mailto(general)}>{address}</a>
            <p>{live ? 'Your second opinion before you buy.' : 'Email for early access.'}</p>
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
