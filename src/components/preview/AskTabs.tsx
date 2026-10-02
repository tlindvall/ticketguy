'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

/**
 * "Three things to ask your guy" as a scroll story: the three asks stack on the left and the page scrolls
 * normally; on the right a sticky, full-bleed scene shows the ask nearest the middle of the screen and
 * crossfades as the next one arrives (IntersectionObserver, no scroll-jacking). Photos are toned navy and lime
 * so they read as one set; the catch adds a small seat-map inset. On phones each ask carries its own image.
 * Photos are owner-supplied. Each button opens a draft in the visitor's own email app.
 */
type Ask = { key: string; label: string; line: string; points: string[]; subject: string; lines: string[]; body: string; scene: 'concert' | 'sport' | 'catch' };

const ASKS: Ask[] = [
  { key: 'sports', label: 'Sports', line: 'Buy now or hold off? Tell me the game and how many. I’ll tell you whether prices are getting more expensive or cheaper, and what that means for you.', points: ['Whether asking prices are trending up or down', 'What the trend means for your group and the seats you want', 'A buy-or-wait call when the price history supports one, and a straight answer when it doesn’t'], subject: 'Knicks next Saturday. Buy now or hold off?', lines: ['Knicks next Saturday.', 'Buy now or hold off?'], body: 'How many tickets:\nWhere you’d like to sit (optional):\n', scene: 'sport' },
  { key: 'concerts', label: 'Concerts', line: 'Found tickets for a show? Send the listing and I’ll tell you if the price makes sense, and what it really costs.', points: ['What you’d actually pay, fees included', 'How the price sits against similar seats, where we have the data', 'Whether the seats suit you: the view, the row, together or not'], subject: 'Is $150 each for these Dua Lipa tickets a good price?', lines: ['Is $150 each for these', 'Dua Lipa tickets', 'a good price?'], body: 'Ticket link or screenshot:\nHow many (optional):\n', scene: 'concert' },
  { key: 'catch', label: 'The catch', line: 'Seats look cheap? Send them over. I’ll check the view, the delivery and the fees before you pay.', points: ['View: limited, obstructed or side-on', 'Delivery: when the tickets actually reach you', 'Fees and restrictions that aren’t shown up front'], subject: 'These seats look cheap. What’s the catch?', lines: ['These seats look cheap.', 'What’s the catch?'], body: 'Ticket link or screenshot:\nWhat you’re unsure about (optional):\n', scene: 'catch' },
];

const IMAGES: Record<Ask['scene'], { src: string; alt: string; inset?: { src: string; alt: string }; pos?: string }> = {
  concert: { src: '/brand/asks/concert-stage.webp', alt: 'A pop star singing on stage, toned navy and lime.', pos: '50% 8%' },
  sport: { src: '/brand/asks/sports.webp', alt: 'A Knicks guard going up for a layup in a packed arena, toned navy and lime.' },
  catch: { src: '/brand/asks/catch-rink.webp', alt: 'The view of a hockey rink from the upper level, toned navy and lime.', inset: { src: '/brand/asks/catch-seats.webp', alt: 'Seat map: Section 330, Row 3, six seats highlighted; exact seat numbers not provided.' } },
};

export function AskTabs({ address }: { address: string }) {
  const [active, setActive] = useState(0);
  const steps = useRef<Array<HTMLElement | null>>([]);
  const mailto = (a: Ask) => `mailto:${address}?subject=${encodeURIComponent(a.subject)}&body=${encodeURIComponent(a.body)}`;

  useEffect(() => {
    // The ask crossing the middle band of the viewport is the one on show.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  const mail = (a: Ask) => (
    <a className="asks-mail" href={mailto(a)} aria-label={`Start an email: ${a.subject}`}>
      <span className="asks-mail-bar">New message</span>
      <span className="asks-mail-row"><span className="mono">To:</span> {address}</span>
      <span className="asks-mail-subject"><span className="mono">Subject:</span>{a.lines.map((l) => <span key={l} className="asks-mail-line">{l}</span>)}</span>
    </a>
  );
  const scene = (a: Ask, eager = false) => {
    const img = IMAGES[a.scene];
    return (
      <>
        <Image src={img.src} alt={img.alt} fill sizes="(max-width: 900px) 100vw, 60vw" priority={eager} style={img.pos ? { objectPosition: img.pos } : undefined} />
        {img.inset ? (
          <span className="asks-inset">
            <Image src={img.inset.src} alt={img.inset.alt} width={640} height={407} sizes="(max-width: 900px) 60vw, 26vw" />
          </span>
        ) : null}
      </>
    );
  };

  return (
    <section className="asks wrap" aria-labelledby="asks-title">
      <div className="asks-left">
        <p className="asks-kicker" id="asks-title">Three things to ask your guy</p>
        {ASKS.map((x, i) => (
          <article key={x.key} ref={(el) => { steps.current[i] = el; }} data-i={i} className={`asks-step${i === active ? ' is-active' : ''}`} aria-labelledby={`ask-${x.key}`}>
            <span className="asks-count" aria-hidden="true">0{i + 1} / 0{ASKS.length}</span>
            <h3 id={`ask-${x.key}`} className="asks-label">{x.label}</h3>
            <p className="asks-line">{x.line}</p>
            <ul className="asks-points">{x.points.map((pt) => <li key={pt}>{pt}</li>)}</ul>
            <a className="btn-lime" href={mailto(x)}>Start an email <span aria-hidden="true">›</span></a>
            <div className="asks-media" aria-hidden="true">{scene(x)}{mail(x)}</div>
          </article>
        ))}
      </div>
      <div className="asks-stage" aria-hidden="true">
        {ASKS.map((x, i) => (
          <div key={x.key} className={`asks-scene${i === active ? ' is-on' : ''}`}>{scene(x, i === 0)}{mail(x)}</div>
        ))}
        <ol className="asks-dots">{ASKS.map((x, i) => <li key={x.key} className={i === active ? 'is-on' : undefined} />)}</ol>
      </div>
    </section>
  );
}
