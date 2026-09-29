import Link from 'next/link';
import { env } from '@/lib/config/env';
import { proposedEmail } from '@/components/preview/signature-proposal';
import '@/components/preview/inbox.css';

const BODY = ['Hey, I’d start with these two options.'];

/**
 * The signature in context: an ordinary email with a modest signature, framed only as far as a preview
 * needs (the From/To/Subject lines are presentation, not part of what is sent). Each frame is the exact
 * HTML, rendered in isolation like an email client, at a desktop and a phone width.
 */
export default function SignaturePreview() {
  const e = env();
  // Images load from this server, whatever port it runs on; a sent email would use the absolute APP_URL.
  const appUrl = '';
  const first = proposedEmail({ appUrl, address: e.CONCIERGE_INBOUND_ADDRESS, paragraphs: BODY });
  const follow = proposedEmail({ appUrl, address: e.CONCIERGE_INBOUND_ADDRESS, paragraphs: ['Both are still up. The first is the one I’d pick for four of you.'], followUp: true });
  return (
    <div className="tgx">
      <p className="preview-flag">Preview of brand direction 01. Live email is unchanged.</p>
      <main className="wrap sig-page">
        <p className="sig-back"><Link className="link" href="/preview/home">Homepage preview</Link></p>
        {[{ id: 'first', title: 'First reply in a conversation', mail: first, h: [215, 240] }, { id: 'follow', title: 'Later reply in the same thread', mail: follow, h: [165, 200] }].map((m) => (
          <section key={m.id} className="sig-section" aria-labelledby={`${m.id}-title`}>
            <h2 id={`${m.id}-title`} className="sig-heading">IN THE INBOX <span>· {m.title}</span></h2>
            <div className="sig-frames">
              {[{ label: 'Desktop', width: 640, height: m.h[0]! }, { label: 'Phone', width: 360, height: m.h[1]! }].map((f) => (
                <figure key={f.label} className="sig-frame" style={{ maxWidth: f.width }}>
                  <dl className="sig-meta">
                    <div><dt>From:</dt><dd>{e.CONCIERGE_INBOUND_ADDRESS}</dd></div>
                    <div><dt>To:</dt><dd>you</dd></div>
                    <div><dt>Subject:</dt><dd>Re: Saturday show?</dd></div>
                  </dl>
                  <iframe title={`${m.title}, ${f.label.toLowerCase()} width`} srcDoc={m.mail.html} width={f.width} height={f.height} sandbox="" />
                  <figcaption>{f.label}, {f.width}px</figcaption>
                </figure>
              ))}
            </div>
            <details className="sig-text">
              <summary>Plain-text version</summary>
              <pre>{m.mail.text}</pre>
            </details>
          </section>
        ))}
      </main>
    </div>
  );
}
