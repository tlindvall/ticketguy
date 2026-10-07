import Link from 'next/link';
import { getDb } from '@/lib/db';
import { renderTemplate } from '@/lib/email/templates';
import { renderPreviewSamples } from '@/lib/brand/preview-samples';
import '@/components/preview/inbox.css';

/**
 * The ticket brief (Oct 6) as the customer gets it, one made-up pick per banner template: hockey, basketball,
 * baseball, football, soccer, a college game, a concert and a Broadway show. Every team we can draw is at
 * /preview/teams.
 */
export default async function TicketBriefPreview() {
  const { db } = await getDb();
  const samples = await renderPreviewSamples(db);
  const mails = samples.map((s) => ({ ...s, mail: renderTemplate('raw', { text: s.text, html: s.html, firstName: 'Tobias' }, { appUrl: '', postalAddress: null, signature: 'full' }) }));
  return (
    <div className="tgx">
      <p className="preview-flag">Preview of the ticket brief. Made-up picks; nothing here is a real listing.</p>
      <main className="wrap sig-page">
        <p className="sig-back">One sample per banner template. <Link className="link" href="/preview/teams">Every team we can draw</Link></p>
        {mails.map((m) => (
          <section key={m.id} className="sig-section" aria-labelledby={`${m.id}-title`}>
            <h2 id={`${m.id}-title`} className="sig-heading">TICKET BRIEF <span>· {m.title}</span></h2>
            {!m.artwork && <p className="sig-back">No artwork: run <code>pnpm db:migrate</code> to load the team file.</p>}
            <div className="sig-frames">
              {[{ label: 'Desktop', width: 640, height: 900 }, { label: 'Phone', width: 360, height: 1060 }].map((f) => (
                // Same origin, scripts off: a sandbox with no origin can't load this app's images in development.
                <figure key={f.label} className="sig-frame" style={{ maxWidth: f.width }}>
                  <iframe title={`${m.title}, ${f.label.toLowerCase()} width`} srcDoc={m.mail.html} width={f.width} height={f.height} sandbox="allow-same-origin" />
                  <figcaption>{f.label}, {f.width}px</figcaption>
                </figure>
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
