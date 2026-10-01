'use client';
import { useState } from 'react';

/**
 * "Three things to ask your guy" as one feature panel: the categories on the left (the active one opens with
 * its line and a draft button; the others wait, greyed), and on the right a full-height scene for that
 * category with its email window on top. Scenes are drawn in the brand palette, not photos: no artist's
 * likeness or team marks. Each button opens a draft in the visitor's own email app.
 */
type Ask = { key: string; label: string; line: string; subject: string; lines: string[]; body: string; scene: 'concert' | 'sport' | 'catch' };

const ASKS: Ask[] = [
  { key: 'concerts', label: 'Concerts', line: 'Found tickets for a show? Send the listing and I’ll tell you if the price makes sense, and what it really costs.', subject: 'Is $150 each for these Dua Lipa tickets a good price?', lines: ['Is $150 each for these', 'Dua Lipa tickets', 'a good price?'], body: 'Ticket link or screenshot:\nHow many (optional):\n', scene: 'concert' },
  { key: 'sports', label: 'Sports', line: 'Going as a group? Tell me the game, how many and your budget. I’ll look at what fits, seats together included.', subject: 'Four Knicks tickets next Saturday. Under $600 total.', lines: ['Four Knicks tickets', 'next Saturday.', 'Under $600 total.'], body: 'Where you’d like to sit (optional):\nSeats together? (optional)\n', scene: 'sport' },
  { key: 'catch', label: 'The catch', line: 'Seats look cheap? Send them over. I’ll check the view, the delivery and the fees before you pay.', subject: 'These seats look cheap. What’s the catch?', lines: ['These seats look cheap.', 'What’s the catch?'], body: 'Ticket link or screenshot:\nWhat you’re unsure about (optional):\n', scene: 'catch' },
];

function Scene({ kind }: { kind: Ask['scene'] }) {
  if (kind === 'concert') {
    return (
      <svg viewBox="0 0 600 560" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <rect width="600" height="560" fill="#142438" />
        {[90, 230, 370, 510].map((x, i) => <polygon key={x} points={`${x - 14},0 ${x + 14},0 ${x + 120 - i * 40},420 ${x - 120 + i * 30},420`} fill="#d7f36b" opacity={0.13 + (i % 2) * 0.06} />)}
        {[90, 230, 370, 510].map((x) => <rect key={x} x={x - 16} y="0" width="32" height="18" rx="3" fill="#d7f36b" />)}
        <rect x="60" y="330" width="480" height="26" fill="#0d1a2a" />
        <rect x="60" y="326" width="480" height="4" fill="#d7f36b" opacity=".7" />
        <g fill="#0d1a2a">{Array.from({ length: 14 }, (_, i) => <circle key={i} cx={20 + i * 44} cy={470 + (i % 3) * 12} r="38" />)}</g>
        <g stroke="#0d1a2a" strokeWidth="9" strokeLinecap="round">{[70, 160, 300, 420, 520].map((x, i) => <line key={x} x1={x} y1="450" x2={x + (i % 2 ? 14 : -12)} y2="388" />)}</g>
        <rect y="500" width="600" height="60" fill="#0d1a2a" />
      </svg>
    );
  }
  if (kind === 'sport') {
    return (
      <svg viewBox="0 0 600 560" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <rect width="600" height="560" fill="#142438" />
        <g fill="#1f3550">{Array.from({ length: 6 }, (_, r) => <rect key={r} x={-40 + r * 14} y={20 + r * 26} width={680 - r * 28} height="16" rx="8" />)}</g>
        <polygon points="40,560 140,190 460,190 560,560" fill="#e9c98f" />
        <polygon points="40,560 140,190 460,190 560,560" fill="none" stroke="#f7f4ec" strokeWidth="4" />
        <line x1="300" y1="190" x2="300" y2="560" stroke="#f7f4ec" strokeWidth="4" />
        <ellipse cx="300" cy="360" rx="70" ry="34" fill="none" stroke="#f7f4ec" strokeWidth="4" />
        <polygon points="232,190 368,190 380,262 220,262" fill="#d7f36b" opacity=".85" stroke="#f7f4ec" strokeWidth="4" />
        <rect x="282" y="150" width="36" height="26" fill="none" stroke="#f7f4ec" strokeWidth="4" />
        <circle cx="300" cy="182" r="9" fill="none" stroke="#d7f36b" strokeWidth="3" />
        <circle cx="356" cy="300" r="12" fill="#e07a2e" stroke="#142438" strokeWidth="3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 600 560" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="600" height="560" fill="#e6e9ed" />
      <rect x="150" y="40" width="300" height="60" rx="6" fill="#142438" />
      <text x="300" y="78" textAnchor="middle" fill="#f7f4ec" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="20">STAGE</text>
      <g>
        {Array.from({ length: 8 }, (_, r) => Array.from({ length: 14 }, (_, c) => {
          const x = 70 + c * 34 + (r % 2) * 6, y = 130 + r * 30;
          const pick = r === 3 && (c === 9 || c === 10);
          const hidden = (r === 0 || r === 1) && c >= 9 && c <= 10;
          if (hidden) return null;
          return <circle key={`${r}-${c}`} cx={x} cy={y} r="11" fill={pick ? '#d7f36b' : '#ffffff'} stroke="#142438" strokeWidth={pick ? 3 : 1.5} opacity={pick ? 1 : 0.8} />;
        }))}
      </g>
      <rect x="366" y="150" width="62" height="38" rx="4" fill="#536174" />
      <text x="397" y="174" textAnchor="middle" fill="#fff" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="12">SOUND</text>
      <circle cx="452" cy="250" r="18" fill="#d7f36b" stroke="#142438" strokeWidth="3" />
      <text x="452" y="258" textAnchor="middle" fill="#142438" fontFamily="Arial, sans-serif" fontWeight="800" fontSize="24">!</text>
    </svg>
  );
}

export function AskTabs({ address }: { address: string }) {
  const [active, setActive] = useState(0);
  const mailto = (a: Ask) => `mailto:${address}?subject=${encodeURIComponent(a.subject)}&body=${encodeURIComponent(a.body)}`;
  const a = ASKS[active]!;
  return (
    <section className="asks wrap" aria-labelledby="asks-title">
      <div className="asks-left">
        <p className="asks-kicker" id="asks-title">Three things to ask your guy</p>
        <div className="asks-tabs" role="tablist" aria-label="What to ask">
          {ASKS.map((x, i) => (
            <div key={x.key} className={`asks-item${i === active ? ' is-active' : ''}`}>
              <button type="button" role="tab" id={`ask-tab-${x.key}`} aria-selected={i === active} aria-controls="ask-panel" className="asks-tab" onClick={() => setActive(i)}>{x.label}</button>
              {i === active ? (
                <div className="asks-open">
                  <p>{x.line}</p>
                  <a className="btn-lime" href={mailto(x)}>Start an email <span aria-hidden="true">›</span></a>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div className="asks-panel" id="ask-panel" role="tabpanel" aria-labelledby={`ask-tab-${a.key}`}>
        <div key={a.key} className="asks-scene"><Scene kind={a.scene} /></div>
        <a key={`${a.key}-mail`} className="asks-mail" href={mailto(a)} aria-label={`Start an email: ${a.subject}`}>
          <span className="asks-mail-bar">New message</span>
          <span className="asks-mail-row"><span className="mono">To:</span> {address}</span>
          <span className="asks-mail-subject"><span className="mono">Subject:</span>{a.lines.map((l) => <span key={l} className="asks-mail-line">{l}</span>)}</span>
        </a>
      </div>
    </section>
  );
}
