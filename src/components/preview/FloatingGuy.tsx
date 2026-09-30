'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * The ticket mark as a companion: it joins the visitor as the page opens, stays in the corner as they scroll,
 * and every few seconds blinks, smiles or winks. At the closing section it turns to them and says
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
      <svg viewBox="0 0 80 60" className={`tg-buddy-mark mood-${face}${winking ? ' is-wink' : ''}`} aria-hidden="true">
        <path d="M8 8H72V19C59 19 59 41 72 41V52H8V41C21 41 21 19 8 19Z" fill="#d7f36b" stroke="#142438" strokeWidth="4" strokeLinejoin="round" />
        <g className="eye eye-l"><ellipse cx="32" cy="28" rx="6" ry="10" fill="#142438" /><ellipse cx="34" cy="24" rx="2" ry="4" fill="#fff" /></g>
        <g className="eye eye-r"><ellipse cx="49" cy="28" rx="6" ry="10" fill="#142438" /><ellipse cx="51" cy="24" rx="2" ry="4" fill="#fff" /></g>
        <path className="wink-lid" d="M43 29Q49 24 55 29" fill="none" stroke="#142438" strokeWidth="3.5" strokeLinecap="round" />
        <path className="smile" d="M31 42Q40.5 50 50 42" fill="none" stroke="#142438" strokeWidth="3.5" strokeLinecap="round" />
      </svg>
    </a>
  );
}
