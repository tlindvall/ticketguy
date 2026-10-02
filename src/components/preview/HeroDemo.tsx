'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyAddress } from './CopyAddress';
import { EXAMPLES, EXAMPLE_EVENT, type ExampleKey } from './examples';
import { GuyMark, type GuyMood } from './GuyMark';
import { EnvelopeIcon, PaperclipIcon, ReplyIcon } from './icons';
import { PixelCursor } from './PixelCursor';

/**
 * The hero: the one real "New message" window and its illustrative reply. Above it sits a little inbox of three
 * subject lines; picking one plays that exchange (the request types itself, a pixel cursor presses the button,
 * the reply lands with a "New mail" flash and the ticket guy pops up over the window). The questions section
 * further down can ask for an example too (EXAMPLE_EVENT). Everything stays real: the fields are editable and
 * the button opens the visitor's email app with exactly that text. Touching the composer stops the
 * demonstration and hands it over. Reduced motion shows the finished state at once.
 */
type Phase = 'idle' | 'subject' | 'body' | 'attach' | 'ask' | 'cursor' | 'press' | 'checking' | 'reply' | 'done';

export function HeroDemo({ address, cta }: { address: string; cta: string }) {
  const [current, setCurrent] = useState<ExampleKey>('wait');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [guy, setGuy] = useState<GuyMood | null>(null);
  // The reply overlaps the composer once it lands; touching the composer brings the composer back to the front.
  const [composeFront, setComposeFront] = useState(false);
  const timers = useRef<number[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const handedOver = useRef(false);
  const reduced = useRef(false);
  const ex = EXAMPLES.find((e) => e.key === current)!;

  const clear = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };
  const at = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)); };

  const finish = useCallback((key: ExampleKey) => {
    clear();
    const e = EXAMPLES.find((x) => x.key === key)!;
    setSubject(e.subject); setBody(e.link + e.ask); setCursor(null); setPhase('done'); setGuy('idle');
  }, []);

  const play = useCallback((key: ExampleKey, quick = false) => {
    clear();
    const e = EXAMPLES.find((x) => x.key === key)!;
    handedOver.current = false;
    setCurrent(key);
    if (reduced.current) { setComposeFront(false); finish(key); return; }
    const k = quick ? 0.55 : 1;
    setSubject(''); setBody(''); setCursor(null); setPhase('idle'); setComposeFront(false); setGuy(null);
    let t = quick ? 250 : 700;
    at(t, () => setPhase('subject'));
    for (let i = 1; i <= e.subject.length; i++) at(t + i * 55 * k, () => setSubject(e.subject.slice(0, i)));
    t += e.subject.length * 55 * k + 300 * k;
    at(t, () => setPhase('body'));
    for (let i = 1; i <= e.link.length; i++) at(t + i * 20 * k, () => setBody(e.link.slice(0, i)));
    t += e.link.length * 20 * k + 260 * k;
    at(t, () => setPhase('attach'));
    t += 600 * k;
    at(t, () => setPhase('ask'));
    for (let i = 1; i <= e.ask.length; i++) at(t + i * 32 * k, () => setBody(e.link + e.ask.slice(0, i)));
    t += e.ask.length * 32 * k + 450 * k;
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
    t += 1200;
    at(t, () => { setCursor(null); setPhase('reply'); setGuy('smile'); });
    t += 1700;
    at(t, () => setGuy('idle'));
    t += 2300;
    at(t, () => { setPhase('done'); setGuy('wink'); });
    t += 450;
    at(t, () => setGuy('idle'));
  }, [finish]);

  useEffect(() => {
    try {
      reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      // No matchMedia: play as normal.
    }
    // Start on the next tick, not inside the effect body (no cascading render on mount).
    const start = window.setTimeout(() => play('wait'), 0);
    const onAsk = (e: Event) => play((e as CustomEvent<ExampleKey>).detail, true);
    window.addEventListener(EXAMPLE_EVENT, onAsk);
    return () => { window.clearTimeout(start); clear(); window.removeEventListener(EXAMPLE_EVENT, onAsk); };
  }, [play]);

  // The visitor takes over: stop the film and finish this example's fields so they can edit and send it.
  const takeOver = () => {
    setComposeFront(true);
    if (handedOver.current || phase === 'done') return;
    handedOver.current = true;
    finish(current);
  };

  const href = `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const attached = !['idle', 'subject', 'body'].includes(phase);
  const showReply = phase === 'checking' || phase === 'reply' || phase === 'done';
  const replied = phase === 'reply' || phase === 'done';

  const W = 320, H = 64, P = 6;
  const series = ex.market?.series;
  let line = '', lx = '0', ly = '0';
  if (series) {
    const lo = Math.min(...series), hi = Math.max(...series);
    const pts = series.map((v, i) => `${(P + (i / (series.length - 1)) * (W - 2 * P)).toFixed(1)},${(P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P)).toFixed(1)}`);
    line = pts.join(' ');
    [lx, ly] = pts[pts.length - 1]!.split(',') as [string, string];
  }

  return (
    <div className="hero-demo">
      <div className="inbox-strip" role="group" aria-label="Pick an example question">
        <span className="inbox-strip-bar"><EnvelopeIcon /> Try asking</span>
        {EXAMPLES.map((e) => (
          <button key={e.key} type="button" className={`inbox-row${e.key === current ? ' is-on' : ''}`} aria-pressed={e.key === current} onClick={() => play(e.key, true)}>
            <span className="mono">Subject:</span> {e.subject}
          </button>
        ))}
      </div>

      <div className={`hero-stack${composeFront ? ' compose-front' : ''}`} ref={wrap}>
        <form className="compose win" aria-label="Write to your ticket guy" onSubmit={(e) => { e.preventDefault(); window.location.href = href; }} onPointerDown={takeOver} onFocus={takeOver}>
          <div className="win-bar"><EnvelopeIcon /> New message</div>
          <div className="compose-row">
            <span className="compose-label">To:</span>
            <a className="compose-to" href={`mailto:${address}`}>{address}</a>
          </div>
          <label className="compose-row">
            <span className="compose-label">Subject:</span>
            <input className="compose-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={140} placeholder={phase === 'done' ? ex.subject : ''} />
          </label>
          <label className="compose-body-wrap">
            <span className="sr-only">Message</span>
            <textarea className="compose-body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} placeholder={phase === 'done' ? 'Paste your ticket link and tell me how many you need.' : ''} />
            {attached ? (
              <span className="compose-file" aria-label={`Attached: ${ex.file}`}>
                <span className="compose-file-thumb" aria-hidden="true"><i /><i /><i /></span>
                <PaperclipIcon />
                <span className="mono">{ex.file}</span>
              </span>
            ) : null}
          </label>
          <div className="compose-footer">
            <span className="compose-attach"><PaperclipIcon /><span>Opens your email app. You send it from there.</span></span>
            <CopyAddress address={address} />
            <button type="submit" ref={button} className={`btn-lime${phase === 'press' ? ' is-pressed' : ''}`}>{cta} <span aria-hidden="true">›</span></button>
          </div>
        </form>

        <div className={`hero-reply-wrap${showReply ? ' is-shown' : ''}`}>
          <span className={`hero-guy${guy ? ' is-up' : ''}`} aria-hidden="true"><GuyMark mood={guy ?? 'idle'} /></span>
          <article key={current} className={`hero-reply win${replied ? ' is-replied' : ''}`} aria-label="Illustrative example of a reply, not a live offer" aria-hidden={!showReply}>
            <div className="win-bar reply-titlebar">
              <span><ReplyIcon /> Re: {ex.subject}</span>
              {phase === 'reply' ? <span className="new-mail">New mail</span> : null}
              <span className="reply-flag">Illustrative example — not a live offer</span>
            </div>
            {replied ? (
              <div className="hero-reply-body">
                <p className="hr-line hr-1 hr-event">{ex.event}</p>
                <p className="hr-line hr-1 hr-says">The listing says:</p>
                <ul className="hr-line hr-1 hr-facts">
                  {ex.facts.map((f) => (
                    <li key={f.strong} className={f.flag ? 'is-flag' : undefined}><span className="hr-ok" aria-hidden="true">{f.flag ? '!' : '·'}</span><span><strong>{f.strong}</strong>{f.rest}</span><span className="hr-tag">{f.tag}</span></li>
                  ))}
                </ul>
                {ex.market ? (
                  <div className="hr-line hr-2 hr-found">
                    <p>{ex.market.label} <span className="hr-trend">{ex.market.value}</span></p>
                    {series ? (
                      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Asking prices over the last 30 days: up to a peak, now falling">
                        <polyline points={line} className="hr-path" pathLength={1} />
                        <circle cx={lx} cy={ly} r="5" className="hr-dot" />
                      </svg>
                    ) : null}
                  </div>
                ) : null}
                <p className="hr-line hr-punch"><em className="hr-verdict">{ex.verdict}</em>{ex.call} <span>{ex.note}</span></p>
                <p className="hr-line hr-link"><span className="link">View the seller’s listing ↗</span></p>
              </div>
            ) : (
              <p className="hero-reply-checking">Reading your listing and screenshot<span className="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></p>
            )}
            {phase === 'done' ? <button type="button" className="hero-replay" onClick={() => play(current, true)}>Replay</button> : null}
            {replied ? <button type="button" className="hero-reply-close" onClick={() => setComposeFront(true)} aria-label="Back to the message">×</button> : null}
          </article>
        </div>

        {cursor ? (
          <PixelCursor className={`hero-cursor${phase === 'press' ? ' is-down' : ''}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }} />
        ) : null}
      </div>
    </div>
  );
}
