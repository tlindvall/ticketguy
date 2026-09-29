'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * The brand animation, shown as an optional demonstration below the fold: the headline, a request being
 * written and sent, and the reply with its price chart (marked as an illustrative example in the film itself). It is silent (the audio
 * track is stripped), loops, and has a pause button, since anything that moves for more than five seconds
 * must be stoppable. Visitors who ask for reduced motion get the still frame and start it themselves.
 */
export function HeroVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let reduced = false;
    try {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      // No matchMedia: play as normal.
    }
    if (!reduced) v.play().catch(() => setPlaying(false));
  }, []);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => setPlaying(false));
    else v.pause();
  };

  return (
    <figure className="hero-video">
      <video
        ref={ref}
        src="/brand/hero/ticket-guy.mp4"
        poster="/brand/hero/ticket-guy-poster.webp"
        muted
        loop
        playsInline
        preload="auto"
        width={1920}
        height={1080}
        aria-label="Illustrative animation: you’ve finally got a ticket guy. Someone emails “Knicks next Saturday, four of us, under $150 each”, and the reply finds four tickets at $130 each, with prices trending down, so it suggests holding off another 24 hours. Before you buy, ask your guy."
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <button type="button" className="hero-video-toggle" onClick={toggle} aria-label={playing ? 'Pause animation' : 'Play animation'}>
        {playing ? (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" fill="currentColor" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2l10 6-10 6z" fill="currentColor" /></svg>
        )}
      </button>
    </figure>
  );
}
