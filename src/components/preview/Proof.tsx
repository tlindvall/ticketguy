/**
 * Proof: one question and one helpful answer (decision, total with its fee basis, the reason). It sits over the three duotone photos, which crossfade slowly behind it for atmosphere (pure CSS;
 * reduced motion holds the first). Illustrative and labelled so; swap in a real, anonymized thread when one
 * is cleared for use.
 */
// Each photo framed on its subject: the concert shot keeps the singer's face in view.
const PHOTOS = [
  { src: '/brand/asks/sports.webp', pos: 'center 30%' },
  { src: '/brand/asks/concert-stage.webp', pos: 'center 6%' },
  { src: '/brand/asks/catch-rink.webp', pos: 'center 40%' },
];

export function Proof() {
  return (
    <section className="proof" aria-labelledby="proof-title">
      <div className="proof-photos" aria-hidden="true">
        {PHOTOS.map((p) => <span key={p.src} style={{ backgroundImage: `url(${p.src})`, backgroundPosition: p.pos }} />)}
      </div>
      <div className="wrap proof-grid">
        <h2 id="proof-title">Here’s what your guy spots.</h2>
        <article className="win proof-thread" aria-label="Illustrative example, not a live offer or a real customer">
          <div className="win-bar"><span className="demo-bar-title">Re: Six together for Morgan Wallen</span><span className="reply-flag">Illustrative example</span></div>
          <div className="proof-msg proof-ask">
            <p className="proof-from"><span className="mono">From:</span> You</p>
            <p>Six together for Morgan Wallen. Are these a good deal?</p>
          </div>
          <div className="proof-msg">
            <p className="proof-from"><span className="mono">From:</span> Your ticket guy</p>
            <p className="demo-decision">I’d choose the six together.</p>
            <p className="demo-total"><strong>$1,425 total</strong> · fees included</p>
            <p className="demo-reason">Your original option splits the group. This costs just <strong>$57 more after fees</strong>, with everyone in one row.</p>
          </div>
        </article>
      </div>
    </section>
  );
}
