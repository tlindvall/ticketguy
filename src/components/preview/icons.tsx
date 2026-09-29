/**
 * Small pixel-grid icons (16×16, square joins, crisp edges): envelope, reply and paperclip, the early-web
 * detail the direction calls for. Decorative: every use sits next to words that say the same thing.
 */
const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'square' as const, strokeLinejoin: 'miter' as const, shapeRendering: 'crispEdges' as const, 'aria-hidden': true };

export function EnvelopeIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M1.75 3.75h12.5v8.5H1.75z" />
      <path d="M2 4l6 5 6-5" />
    </svg>
  );
}

export function ReplyIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M6 3.5L2 7.5l4 4" />
      <path d="M2.5 7.5H10a4 4 0 0 1 4 4v1" />
    </svg>
  );
}

export function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className} strokeLinecap="round" strokeLinejoin="round" shapeRendering="geometricPrecision">
      <path d="M10.5 4.5l-5 5a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3 3 0 0 0-4.2-4.2L3.4 7.4a4.5 4.5 0 0 0 6.4 6.4l4-4" />
    </svg>
  );
}
