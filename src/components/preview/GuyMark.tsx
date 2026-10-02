/**
 * The ticket guy himself, drawn once and shared. `mood` sets the face: idle, blink, smile (grin, a wave and a
 * little hop) or wink. Decorative: every use sits next to words that say what he means.
 */
export type GuyMood = 'idle' | 'blink' | 'smile' | 'wink';

export function GuyMark({ mood = 'idle', className = '' }: { mood?: GuyMood; className?: string }) {
  return (
    <svg viewBox="0 0 128 160" className={`guy-mark mood-${mood}${mood === 'wink' ? ' is-wink' : ''} ${className}`} aria-hidden="true">
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
  );
}
