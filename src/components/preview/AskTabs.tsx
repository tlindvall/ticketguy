'use client';
import Image from 'next/image';
import { useState } from 'react';

/**
 * "Three things to ask your guy" as one feature panel: the categories on the left (the active one opens with
 * its line and a draft button; the others wait, greyed), and on the right a full-height scene for that
 * category with its email window on top: photos toned navy and lime so they read as one set (the catch
 * tab shows its finished graphic whole, without the window). Photos are owner-supplied. Each button opens a draft in the visitor's own email app.
 */
type Ask = { key: string; label: string; line: string; subject: string; lines: string[]; body: string; scene: 'concert' | 'sport' | 'catch' };

const ASKS: Ask[] = [
  { key: 'concerts', label: 'Concerts', line: 'Found tickets for a show? Send the listing and I’ll tell you if the price makes sense, and what it really costs.', subject: 'Is $150 each for these Dua Lipa tickets a good price?', lines: ['Is $150 each for these', 'Dua Lipa tickets', 'a good price?'], body: 'Ticket link or screenshot:\nHow many (optional):\n', scene: 'concert' },
  { key: 'sports', label: 'Sports', line: 'Going as a group? Tell me the game, how many and your budget. I’ll look at what fits, seats together included.', subject: 'Four Knicks tickets next Saturday. Under $600 total.', lines: ['Four Knicks tickets', 'next Saturday.', 'Under $600 total.'], body: 'Where you’d like to sit (optional):\nSeats together? (optional)\n', scene: 'sport' },
  { key: 'catch', label: 'The catch', line: 'Seats look cheap? Send them over. I’ll check the view, the delivery and the fees before you pay.', subject: 'These seats look cheap. What’s the catch?', lines: ['These seats look cheap.', 'What’s the catch?'], body: 'Ticket link or screenshot:\nWhat you’re unsure about (optional):\n', scene: 'catch' },
];

const IMAGES: Record<Ask['scene'], { src: string; alt: string; whole?: boolean; pos?: string }> = {
  concert: { src: '/brand/asks/concert.webp', alt: 'A pop star singing on stage, toned navy and lime.', pos: '50% 4%' },
  sport: { src: '/brand/asks/sports.webp', alt: 'A Knicks guard going up for a layup in a packed arena, toned navy and lime.' },
  catch: { src: '/brand/asks/catch.webp', alt: 'What’s the catch with these seats? The view from Section 330, Row 3, six tickets at $106 each including fees, and an Ask Ticket Guy button.', whole: true },
};

export function AskTabs({ address }: { address: string }) {
  const [active, setActive] = useState(0);
  const mailto = (a: Ask) => `mailto:${address}?subject=${encodeURIComponent(a.subject)}&body=${encodeURIComponent(a.body)}`;
  const a = ASKS[active]!;
  const img = IMAGES[a.scene];
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
        <div key={a.key} className={`asks-scene${img.whole ? ' is-whole' : ''}`}>
          <Image src={img.src} alt={img.alt} fill sizes="(max-width: 900px) 100vw, 55vw" style={img.pos ? { objectPosition: img.pos } : undefined} />
        </div>
        {img.whole ? null : (
          <a key={`${a.key}-mail`} className="asks-mail" href={mailto(a)} aria-label={`Start an email: ${a.subject}`}>
            <span className="asks-mail-bar">New message</span>
            <span className="asks-mail-row"><span className="mono">To:</span> {address}</span>
            <span className="asks-mail-subject"><span className="mono">Subject:</span>{a.lines.map((l) => <span key={l} className="asks-mail-line">{l}</span>)}</span>
          </a>
        )}
      </div>
    </section>
  );
}
