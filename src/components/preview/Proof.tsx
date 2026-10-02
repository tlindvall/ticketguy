/**
 * Proof: one whole exchange, read top to bottom: the question, what the guy spotted in the listing, and the
 * call. It sits over the three duotone photos, which crossfade slowly behind it for atmosphere (pure CSS;
 * reduced motion holds the first). Illustrative (labelled for screen readers); swap in a real, anonymized thread when one
 * is cleared for use.
 */
// Each photo framed on its subject: the concert shot keeps the singer's face in view.
const PHOTOS = [
  { src: '/brand/asks/sports.webp', pos: 'center 30%' },
  { src: '/brand/asks/concert-stage.webp', pos: 'center 6%' },
  { src: '/brand/asks/catch-rink.webp', pos: 'center 40%' },
];

export function Proof({ mailto }: { mailto: string }) {
  return (
    <section className="proof" aria-labelledby="proof-title">
      <div className="proof-photos" aria-hidden="true">
        {PHOTOS.map((p) => <span key={p.src} style={{ backgroundImage: `url(${p.src})`, backgroundPosition: p.pos }} />)}
      </div>
      <div className="wrap proof-grid">
        <div className="proof-copy">
          <h2 id="proof-title">What a useful reply looks like.</h2>
          <p>A question, the thing worth knowing, and a clear call. In plain English, in the same thread.</p>
          <a className="btn-lime" href={mailto}>Email your ticket guy <span aria-hidden="true">›</span></a>
        </div>
        <article className="win proof-thread" aria-label="Illustrative example of an exchange, not a live offer">
          <div className="win-bar reply-titlebar"><span>Re: Six of us for Morgan Wallen</span></div>
          <div className="proof-msg proof-ask">
            <span className="proof-tag">01 · The question</span>
            <p className="proof-from"><span className="mono">From:</span> You</p>
            <p>Six of us for Morgan Wallen at MetLife, Aug 7. Found Section 120, Row 15 for <strong>$1,140</strong>. Good deal?</p>
          </div>
          <div className="proof-msg">
            <span className="proof-tag">02 · What I spotted</span>
            <p className="proof-from"><span className="mono">From:</span> Your ticket guy</p>
            <ul className="proof-list">
              <li><span className="proof-mark" aria-hidden="true">!</span><span>The listing says <strong>“seated in pairs”</strong>: six tickets, but three sets of two.</span></li>
              <li><span className="proof-mark" aria-hidden="true">!</span><span>$1,140 is before fees. The listing’s own total is <strong>$1,368</strong>.</span></li>
            </ul>
          </div>
          <div className="proof-msg proof-call">
            <span className="proof-tag">03 · My call</span>
            <p className="proof-verdict">Skip this one if you want to sit together.</p>
            <p>Section 118, Row 9 lists six together for $1,425 with fees: $57 more, all in one row. I’d check that listing first.</p>
          </div>
        </article>
      </div>
    </section>
  );
}
