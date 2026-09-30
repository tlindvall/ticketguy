'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * The ticket guy himself (the mascot) as a companion: it joins the visitor as the page opens, stays in the corner as they scroll,
 * and every few seconds blinks, grins and waves, or winks. At the closing section he turns to them and says
 * "I've got you!" — the page's promise in his voice. Clicking him goes back up to the composer.
 * The bubble is decoration; the link's label says where it goes. Reduced motion keeps his face still.
 */
type Mood = 'idle' | 'blink' | 'smile' | 'wink';

export function FloatingGuy() {
  const [shown, setShown] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [mood, setMood] = useState<Mood>('idle');
  const timer = useRef<number | undefined>(undefined);

  // Joins a moment after the page loads; says the line when the closing section is on screen.
  useEffect(() => {
    const show = window.setTimeout(() => setShown(true), 900);
    const closing = document.querySelector('.closing');
    if (!closing || typeof IntersectionObserver === 'undefined') return () => window.clearTimeout(show);
    const endIo = new IntersectionObserver(([e]) => setAtEnd(!!e && e.isIntersecting), { threshold: 0.35 });
    endIo.observe(closing);
    return () => { window.clearTimeout(show); endIo.disconnect(); };
  }, []);

  // Now and then: a blink, a smile or a wink. Never while reduced motion is asked for.
  useEffect(() => {
    let reduced = false;
    try {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      // No matchMedia: animate as normal.
    }
    if (reduced || !shown || atEnd) return;
    const next = () => {
      timer.current = window.setTimeout(() => {
        const r = Math.random();
        const m: Mood = r < 0.5 ? 'blink' : r < 0.8 ? 'smile' : 'wink';
        setMood(m);
        timer.current = window.setTimeout(() => { setMood('idle'); next(); }, m === 'blink' ? 180 : m === 'wink' ? 450 : 1600);
      }, 2800 + Math.random() * 3200);
    };
    next();
    return () => window.clearTimeout(timer.current);
  }, [shown, atEnd]);

  const face: Mood = atEnd ? 'smile' : mood;
  const winking = mood === 'wink' || atEnd;
  return (
    <a href="#hero-title" className={`tg-buddy${shown ? ' is-shown' : ''}${atEnd ? ' is-end' : ''}`} aria-label="Back to the top: email your ticket guy" tabIndex={shown ? 0 : -1}>
      <span className="tg-buddy-bubble" aria-hidden={!atEnd}>I’ve got you!</span>
      <svg viewBox="0 0 128 160" className={`tg-buddy-mark mood-${face}${winking ? ' is-wink' : ''}`} aria-hidden="true">
        <g fill="none" stroke="#142438" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M33 83L17 100L29 108M49 131L46 148H35M77 132L81 149H93" />
          <path d="M34 17L97 29L94 43Q79 40 77 55Q75 69 89 72L77 136L14 124L26 61Q40 64 43 50Q46 36 31 32Z" fill="#d7f36b" />
          <g className="arm">
            <path d="M93 88L106 99L111 86" />
            <path className="motion" d="M110 55L121 51M113 66L125 67M108 77L118 83" />
          </g>
          <path className="mouth" d="M40 99Q52 114 66 101" />
          <path className="grin" d="M38 97Q52 120 69 99" strokeWidth="4.5" />
          <path className="wink-lid" d="M60 82Q67 75 74 81" strokeWidth="3.5" />
        </g>
        <g className="eye eye-l"><ellipse cx="49" cy="76" rx="5" ry="9" fill="#142438" transform="rotate(12 49 76)" /></g>
        <g className="eye eye-r"><ellipse cx="67" cy="80" rx="5" ry="9" fill="#142438" transform="rotate(12 67 80)" /></g>
      </svg>
    </a>
  );
}
