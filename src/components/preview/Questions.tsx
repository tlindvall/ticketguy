'use client';
import Image from 'next/image';
import { EXAMPLES, EXAMPLE_EVENT, type ExampleKey } from './examples';
import { EnvelopeIcon } from './icons';

/**
 * Three questions you can ask, as three small email windows over one duotone photo (atmosphere; the replies do
 * the demonstrating). Each opens a draft with that subject, or plays its example in the hero above.
 */
export function Questions({ address }: { address: string }) {
  const mailto = (subject: string, body: string) => `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const show = (key: ExampleKey) => {
    document.getElementById('hero-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.dispatchEvent(new CustomEvent(EXAMPLE_EVENT, { detail: key }));
  };
  return (
    <section className="questions" aria-labelledby="questions-title">
      <div className="questions-photo" aria-hidden="true">
        <Image src="/brand/asks/sports.webp" alt="" fill sizes="100vw" />
      </div>
      <div className="wrap">
        <h2 id="questions-title">Three questions to ask your guy.</h2>
        <p className="questions-sub">Good deal, or a catch? Concerts and major sports across the US.</p>
        <ul className="questions-list">
          {EXAMPLES.map((e) => (
            <li key={e.key} className="win q-card">
              <div className="win-bar"><EnvelopeIcon /> New message</div>
              <p className="q-subject"><span className="mono">Subject:</span> {e.subject}</p>
              <p className="q-blurb">{e.blurb}</p>
              <div className="q-actions">
                <a className="btn-lime" href={mailto(e.subject, e.draft)}>Ask this <span aria-hidden="true">›</span></a>
                <button type="button" className="q-example" onClick={() => show(e.key)}>See the example reply</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
