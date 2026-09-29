'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyAddress } from './CopyAddress';
import { PaperclipIcon } from './icons';

/**
 * The hero: the one real "New message" window, playing its own demonstration once. The request types
 * itself, a pixel cursor presses the button, and an illustrative reply arrives with the call. Everything
 * stays real: the fields are editable and the button opens the visitor's email app with exactly that text
 * (nothing reaches us until they press send there). Touching the composer stops the demonstration and
 * hands it over. Visitors who ask for reduced motion get the finished state at once.
 */
const SUBJECT = 'Knicks next Saturday';
const BODY = 'Four of us. Under $150 each.\nCan you find something decent?';

// Illustrative group price per ticket over 30 days: up to a peak, then trending down to $130.
const SERIES = [146, 145, 147, 144, 146, 145, 147, 146, 148, 147, 150, 149, 152, 155, 158, 161, 165, 168, 170, 169, 166, 162, 158, 153, 149, 145, 141, 137, 134, 130];

type Phase = 'idle' | 'subject' | 'body' | 'cursor' | 'press' | 'checking' | 'reply' | 'done';

export function HeroDemo({ address, cta }: { address: string; cta: string }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const timers = useRef<number[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const handedOver = useRef(false);

  const clear = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };
  const at = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)); };

  const finish = useCallback(() => {
    clear();
    setSubject((s) => s || SUBJECT);
    setBody((b) => b || BODY);
    setCursor(null);
    setPhase('done');
  }, []);

  const play = useCallback(() => {
    clear();
    handedOver.current = false;
    setSubject(''); setBody(''); setCursor(null); setPhase('idle');
    let t = 700;
    at(t, () => setPhase('subject'));
    for (let i = 1; i <= SUBJECT.length; i++) at(t + i * 55, () => setSubject(SUBJECT.slice(0, i)));
    t += SUBJECT.length * 55 + 350;
    at(t, () => setPhase('body'));
    for (let i = 1; i <= BODY.length; i++) at(t + i * 34, () => setBody(BODY.slice(0, i)));
    t += BODY.length * 34 + 500;
    at(t, () => {
      const w = wrap.current?.getBoundingClientRect();
      const b = button.current?.getBoundingClientRect();
      if (!w || !b) return;
      setCursor({ x: w.width + 30, y: b.bottom - w.top + 70 });
      setPhase('cursor');
      // Next frame: glide to the button so the move animates.
      requestAnimationFrame(() => requestAnimationFrame(() => setCursor({ x: b.left - w.left + b.width * 0.62, y: b.top - w.top + b.height * 0.55 })));
    });
    t += 900;
    at(t, () => setPhase('press'));
    t += 260;
    at(t, () => setPhase('checking'));
    t += 1300;
    at(t, () => { setCursor(null); setPhase('reply'); });
    t += 2600;
    at(t, () => setPhase('done'));
  }, []);

  useEffect(() => {
    let reduced = false;
    try {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      // No matchMedia: play as normal.
    }
    // Start on the next tick, not inside the effect body (no cascading render on mount).
    const start = window.setTimeout(() => (reduced ? finish() : play()), 0);
    return () => { window.clearTimeout(start); clear(); };
  }, [finish, play]);

  // The visitor takes over: stop the film, keep whatever is in the fields (filling any still empty).
  const takeOver = () => {
    if (handedOver.current || phase === 'done') return;
    handedOver.current = true;
    finish();
  };

  const href = `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const showReply = phase === 'checking' || phase === 'reply' || phase === 'done';
  const replied = phase === 'reply' || phase === 'done';

  const W = 320, H = 96, P = 6;
  const lo = Math.min(...SERIES), hi = Math.max(...SERIES);
  const pts = SERIES.map((v, i) => `${(P + (i / (SERIES.length - 1)) * (W - 2 * P)).toFixed(1)},${(P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P)).toFixed(1)}`);
  const line = pts.join(' ');
  const [lx, ly] = pts[pts.length - 1]!.split(',');

  return (
    <div className="hero-demo" ref={wrap}>
      <form className="compose" aria-label="Write to your ticket guy" onSubmit={(e) => { e.preventDefault(); window.location.href = href; }} onPointerDown={takeOver} onFocus={takeOver}>
        <div className="compose-titlebar">New message</div>
        <div className="compose-row">
          <span className="compose-label">To:</span>
          <a className="compose-to" href={`mailto:${address}`}>{address}</a>
        </div>
        <label className="compose-row">
          <span className="compose-label">Subject:</span>
          <input className="compose-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={140} placeholder={phase === 'done' ? 'What are you after?' : ''} />
        </label>
        <label className="compose-body-wrap">
          <span className="sr-only">Message</span>
          <textarea className="compose-body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} />
        </label>
        <div className="compose-footer">
          <span className="compose-attach"><PaperclipIcon /><span>Links and screenshots welcome</span></span>
          <CopyAddress address={address} />
          <button type="submit" ref={button} className={`btn-lime${phase === 'press' ? ' is-pressed' : ''}`}>{cta} <span aria-hidden="true">›</span></button>
        </div>
      </form>

      <article className={`hero-reply${showReply ? ' is-shown' : ''}${replied ? ' is-replied' : ''}`} aria-label="Illustrative example of a reply, not a live offer" aria-hidden={!showReply}>
        <div className="reply-titlebar"><span>Re: Knicks next Saturday</span><span className="reply-flag">Illustrative example</span></div>
        {replied ? (
          <div className="hero-reply-body">
            <p className="hr-line hr-1"><strong>Found 4 together at $130 each.</strong></p>
            <div className="hr-line hr-2 hr-chart">
              <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price for four together over the last 30 days: up to $170, now $130 and falling">
                <polygon points={`${P},${H - P} ${line} ${W - P},${H - P}`} className="hr-area" />
                <polyline points={line} className="hr-path" pathLength={1} />
                <circle cx={lx} cy={ly} r="5" className="hr-dot" />
              </svg>
              <span className="hr-badge">▼ 15% this week</span>
            </div>
            <p className="hr-line hr-3">Prices are trending down. I’d hold off: you can probably get these cheaper closer to the game.</p>
          </div>
        ) : (
          <p className="hero-reply-checking mono">Checking prices for 4 together<span className="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></p>
        )}
        {phase === 'done' ? <button type="button" className="hero-replay" onClick={play}>Replay</button> : null}
      </article>

      {cursor ? (
        <svg className={`hero-cursor${phase === 'press' ? ' is-down' : ''}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }} viewBox="0 0 11 17" shapeRendering="crispEdges" aria-hidden="true">
          <path d="M0 0h1v1H0zM0 1h2v1H0zM0 2h1v1H0zM2 2h1v1H2zM0 3h1v1H0zM3 3h1v1H3zM0 4h1v1H0zM4 4h1v1H4zM0 5h1v1H0zM5 5h1v1H5zM0 6h1v1H0zM6 6h1v1H6zM0 7h1v1H0zM7 7h1v1H7zM0 8h1v1H0zM8 8h1v1H8zM0 9h1v1H0zM9 9h1v1H9zM0 10h1v1H0zM6 10h5v1H6zM0 11h1v1H0zM3 11h1v1H3zM6 11h1v1H6zM0 12h1v1H0zM2 12h1v1H2zM4 12h1v1H4zM7 12h1v1H7zM0 13h2v1H0zM4 13h1v1H4zM7 13h1v1H7zM0 14h1v1H0zM5 14h1v1H5zM8 14h1v1H8zM5 15h1v1H5zM8 15h1v1H8zM6 16h2v1H6z" fill="#000" />
          <path d="M1 2h1v1H1zM1 3h2v1H1zM1 4h3v1H1zM1 5h4v1H1zM1 6h5v1H1zM1 7h6v1H1zM1 8h7v1H1zM1 9h8v1H1zM1 10h5v1H1zM1 11h2v1H1zM4 11h2v1H4zM1 12h1v1H1zM5 12h2v1H5zM5 13h2v1H5zM6 14h2v1H6zM6 15h2v1H6z" fill="#fff" />
        </svg>
      ) : null}
      <svg className="mascot" aria-hidden="true"><use href="#ticket-friend" /></svg>
    </div>
  );
}
