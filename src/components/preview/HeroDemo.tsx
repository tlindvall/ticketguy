'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyAddress } from './CopyAddress';
import { PaperclipIcon } from './icons';
import { PixelCursor } from './PixelCursor';

/**
 * The hero: the one real "New message" window, playing its own demonstration once. A second-opinion request
 * types itself (a listing link, the group, the budget), a pixel cursor presses the button, and an illustrative
 * reply judges that listing: whether it meets the request, the group total with fees, the market, the call
 * and when not to follow it, and the seller link. Everything
 * stays real: the fields are editable and the button opens the visitor's email app with exactly that text
 * (nothing reaches us until they press send there). Touching the composer stops the demonstration and
 * hands it over. Visitors who ask for reduced motion get the finished state at once.
 */
const SUBJECT = 'Is this a good deal?';
const BODY = 'stubhub.com/…/knicks-celtics\nFour of us, together. Under $600 total.';

// Illustrative price per ticket for four together over 30 days: up to a peak, then trending down.
const SERIES = [146, 145, 147, 144, 146, 145, 147, 146, 148, 147, 150, 149, 152, 155, 158, 161, 165, 168, 170, 169, 166, 162, 158, 153, 149, 145, 141, 137, 134, 130];

type Phase = 'idle' | 'subject' | 'body' | 'cursor' | 'press' | 'checking' | 'reply' | 'done';

export function HeroDemo({ address, cta }: { address: string; cta: string }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  // The reply overlaps the composer once it lands; touching the composer brings the composer back to the front.
  const [composeFront, setComposeFront] = useState(false);
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
    setSubject(''); setBody(''); setCursor(null); setPhase('idle'); setComposeFront(false);
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
    t += 4000;
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
    setComposeFront(true);
    if (handedOver.current || phase === 'done') return;
    handedOver.current = true;
    finish();
  };

  const href = `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const showReply = phase === 'checking' || phase === 'reply' || phase === 'done';
  const replied = phase === 'reply' || phase === 'done';

  const W = 320, H = 64, P = 6;
  const lo = Math.min(...SERIES), hi = Math.max(...SERIES);
  const pts = SERIES.map((v, i) => `${(P + (i / (SERIES.length - 1)) * (W - 2 * P)).toFixed(1)},${(P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P)).toFixed(1)}`);
  const line = pts.join(' ');
  const [lx, ly] = pts[pts.length - 1]!.split(',');

  return (
    <div className={`hero-demo${composeFront ? ' compose-front' : ''}`} ref={wrap}>
      <form className="compose" aria-label="Write to your ticket guy" onSubmit={(e) => { e.preventDefault(); window.location.href = href; }} onPointerDown={takeOver} onFocus={takeOver}>
        <div className="compose-titlebar">New message</div>
        <div className="compose-row">
          <span className="compose-label">To:</span>
          <a className="compose-to" href={`mailto:${address}`}>{address}</a>
        </div>
        <label className="compose-row">
          <span className="compose-label">Subject:</span>
          <input className="compose-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={140} placeholder={phase === 'done' ? 'Is this a good deal?' : ''} />
        </label>
        <label className="compose-body-wrap">
          <span className="sr-only">Message</span>
          <textarea className="compose-body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} placeholder={phase === 'done' ? 'Paste your ticket link and tell me how many you need.' : ''} />
        </label>
        <div className="compose-footer">
          <span className="compose-attach"><PaperclipIcon /><span>Opens your email app. You send it from there.</span></span>
          <CopyAddress address={address} />
          <button type="submit" ref={button} className={`btn-lime${phase === 'press' ? ' is-pressed' : ''}`}>{cta} <span aria-hidden="true">›</span></button>
        </div>
      </form>

      <article className={`hero-reply${showReply ? ' is-shown' : ''}${replied ? ' is-replied' : ''}`} aria-label="Illustrative example of a reply, not a live offer" aria-hidden={!showReply}>
        <div className="reply-titlebar"><span>Re: Is this a good deal?</span><span className="reply-flag">Illustrative example</span></div>
        {replied ? (
          <div className="hero-reply-body">
            <ul className="hr-line hr-1 hr-facts">
              <li><span className="hr-ok" aria-hidden="true">✓</span><span><strong>4 together</strong>, Section 224, Row 6</span><span className="hr-tag">Meets your request</span></li>
              <li><span className="hr-ok" aria-hidden="true">✓</span><span><strong>$548 total</strong>, fees included</span><span className="hr-tag">Under your $600</span></li>
            </ul>
            <div className="hr-line hr-2 hr-found">
              <p>Price for four together <span className="hr-trend">▼ 15% this week · 140 groups of 4 listed</span></p>
              <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price for four together over the last 30 days: up to a peak, now falling">
                <polyline points={line} className="hr-path" pathLength={1} />
                <circle cx={lx} cy={ly} r="5" className="hr-dot" />
              </svg>
            </div>
            <p className="hr-line hr-punch">Prices are trending down. I’d hold off. <span>Plenty of groups of four are still listed, 9 days out. If these exact seats matter most, buy now.</span></p>
            <p className="hr-line hr-link"><span className="link">View the seller’s listing ↗</span></p>
          </div>
        ) : (
          <p className="hero-reply-checking mono">Checking your listing<span className="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></p>
        )}
        {phase === 'done' ? <button type="button" className="hero-replay" onClick={play}>Replay</button> : null}
        {replied ? <button type="button" className="hero-reply-close" onClick={() => setComposeFront(true)} aria-label="Back to the message">×</button> : null}
      </article>

      {cursor ? (
        <PixelCursor className={`hero-cursor${phase === 'press' ? ' is-down' : ''}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }} />
      ) : null}
    </div>
  );
}
