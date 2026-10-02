'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EXAMPLES, type ExampleKey } from './examples';
import { GuyMark, type GuyMood } from './GuyMark';
import { EnvelopeIcon, PaperclipIcon, ReplyIcon } from './icons';
import { PixelCursor } from './PixelCursor';

/**
 * The hero's illustrative example: one email window, kept apart from the real action (the "Email your ticket
 * guy" button beside it). Three compact choices pick the example. The request types itself, a pixel cursor
 * presses Send, and the reply replaces the request in the same window, decision first, with a "New mail" flash
 * while the ticket guy pops up over it. Request and reply share one grid cell, so the window keeps a stable,
 * natural height and nothing moves below the fold. Nothing is sent. Reduced motion shows the reply at once.
 */
type Phase = 'idle' | 'typing' | 'attach' | 'cursor' | 'press' | 'checking' | 'reply';

export function HeroDemo({ address }: { address: string }) {
  const [current, setCurrent] = useState<ExampleKey>('deal');
  const [subject, setSubject] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [fresh, setFresh] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [guy, setGuy] = useState<GuyMood | null>(null);
  const timers = useRef<number[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLSpanElement>(null);
  const reduced = useRef(false);
  const ex = EXAMPLES.find((e) => e.key === current)!;

  const clear = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };
  const at = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)); };

  const play = useCallback((key: ExampleKey) => {
    clear();
    const e = EXAMPLES.find((x) => x.key === key)!;
    setCurrent(key);
    setCursor(null);
    if (reduced.current) { setSubject(e.subject); setPhase('reply'); setFresh(false); setGuy('idle'); return; }
    setSubject(''); setPhase('typing'); setFresh(false); setGuy(null);
    let t = 250;
    for (let i = 1; i <= e.subject.length; i++) at(t + i * 30, () => setSubject(e.subject.slice(0, i)));
    t += e.subject.length * 30 + 250;
    at(t, () => setPhase('attach'));
    t += 450;
    at(t, () => {
      const w = wrap.current?.getBoundingClientRect();
      const b = button.current?.getBoundingClientRect();
      if (!w || !b) return;
      setCursor({ x: w.width + 24, y: b.bottom - w.top + 50 });
      setPhase('cursor');
      // Next frame: glide to the button so the move animates.
      requestAnimationFrame(() => requestAnimationFrame(() => setCursor({ x: b.left - w.left + b.width * 0.6, y: b.top - w.top + b.height * 0.55 })));
    });
    t += 800;
    at(t, () => setPhase('press'));
    t += 220;
    at(t, () => { setCursor(null); setPhase('checking'); });
    t += 700;
    at(t, () => { setPhase('reply'); setFresh(true); setGuy('smile'); });
    t += 1600;
    at(t, () => { setFresh(false); setGuy('idle'); });
  }, []);

  useEffect(() => {
    try {
      reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      // No matchMedia: play as normal.
    }
    // Start on the next tick, not inside the effect body (no cascading render on mount).
    const start = window.setTimeout(() => play('deal'), 0);
    return () => { window.clearTimeout(start); clear(); };
  }, [play]);

  const replied = phase === 'reply';
  const attached = phase !== 'idle' && phase !== 'typing';

  return (
    <div className="hero-demo" role="region" aria-label="Illustrative example">
      <div className="demo-top">
        <span className="demo-label">Illustrative example</span>
        <div className="demo-picks" role="group" aria-label="Choose an example">
          {EXAMPLES.map((e) => (
            <button key={e.key} type="button" className={`demo-pick${e.key === current ? ' is-on' : ''}`} aria-pressed={e.key === current} onClick={() => play(e.key)}>{e.label}</button>
          ))}
        </div>
      </div>

      <div className="hero-stack" ref={wrap}>
        <span className={`hero-guy${guy ? ' is-up' : ''}`} aria-hidden="true"><GuyMark mood={guy ?? 'idle'} /></span>
        <div className={`win demo-win${replied ? ' is-replied' : ''}`}>
          <div className="win-bar">
            {replied ? <ReplyIcon /> : <EnvelopeIcon />}
            <span className="demo-bar-title">{replied ? `Re: ${ex.subject}` : 'New message'}</span>
            {fresh ? <span className="new-mail">New mail</span> : null}
          </div>
          <div className="demo-panes">
            <div className="demo-pane demo-request" aria-hidden="true">
              <div className="compose-row"><span className="compose-label">To:</span><span className="compose-to">{address}</span></div>
              <div className="compose-row"><span className="compose-label">Subject:</span><span className="compose-subject">{subject}{phase === 'typing' ? <i className="caret" /> : null}</span></div>
              <div className="demo-attach">
                {attached ? (
                  <span className="compose-file">
                    <span className="compose-file-thumb"><i /><i /><i /></span>
                    <PaperclipIcon />
                    <span className="mono">{ex.file}</span>
                  </span>
                ) : null}
              </div>
              <div className="demo-foot">
                {phase === 'checking' ? <span className="demo-checking">Sending<span className="dots"><i>.</i><i>.</i><i>.</i></span></span> : <span />}
                <span ref={button} className={`btn-lime demo-send${phase === 'press' ? ' is-pressed' : ''}`}>Send <span>›</span></span>
              </div>
            </div>
            <div className="demo-pane demo-reply" aria-live="polite">
              {replied ? (
                <>
                  <p className="sr-only">Example request: {ex.subject}</p>
                  <p className="demo-decision">{ex.decision}</p>
                  <p className="demo-total"><strong>{ex.total}</strong> · {ex.basis}</p>
                  <p className="demo-reason">{ex.reason}</p>
                  <div className="demo-link"><span className="link">View the seller’s listing ↗</span><button type="button" className="hero-replay" onClick={() => play(current)}>Replay</button></div>
                </>
              ) : null}
            </div>
          </div>
        </div>
        {cursor ? (
          <PixelCursor className={`hero-cursor${phase === 'press' ? ' is-down' : ''}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }} />
        ) : null}
      </div>
    </div>
  );
}
