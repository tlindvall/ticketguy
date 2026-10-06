import Link from 'next/link';
import { getDb } from '@/lib/db';
import { renderTemplate } from '@/lib/email/templates';
import { renderPreviewSamples } from '@/lib/brand/preview-samples';
import type { ArtMode } from '@/lib/brand/assets';
import '@/components/preview/inbox.css';

/**
 * The ticket brief (Oct 6) as the customer would get it, from made-up picks. "As sent" leaves out every image whose
 * rights aren't confirmed; "with unreviewed images" shows what approving them would look like.
 */
export default async function TicketBriefPreview({ searchParams }: { searchParams: Promise<{ images?: string }> }) {
  const mode: ArtMode = (await searchParams).images === 'all' ? 'preview' : 'send';
  const { db } = await getDb();
  // Images load from this server, whatever port it runs on; a sent email uses the absolute APP_URL.
  const samples = await renderPreviewSamples(db, mode, '');
  // The frames keep this page's origin (scripts stay off): a sandbox with no origin can't load images from a local
  // server, and the concert artwork and signature would show as missing in development.
  const mails = samples.map((s) => ({ ...s, mail: renderTemplate('raw', { text: s.text, html: s.html, firstName: 'Tobias' }, { appUrl: '', postalAddress: null, signature: 'full' }) }));
  return (
    <div className="tgx">
      <p className="preview-flag">Preview of the ticket brief. Made-up picks; nothing here is a real listing.</p>
      <main className="wrap sig-page">
        <p className="sig-back">
          {mode === 'send' ? <>As sent: unreviewed images left out. <Link className="link" href="/preview/ticket-brief?images=all">Show with unreviewed images</Link></> : <>With unreviewed images (never sent until approved). <Link className="link" href="/preview/ticket-brief">Show as sent</Link></>}
        </p>
        {mails.map((m) => (
          <section key={m.id} className="sig-section" aria-labelledby={`${m.id}-title`}>
            <h2 id={`${m.id}-title`} className="sig-heading">TICKET BRIEF <span>· {m.title}</span></h2>
            <div className="sig-frames">
              {[{ label: 'Desktop', width: 640, height: 1080 }, { label: 'Phone', width: 360, height: 1320 }].map((f) => (
                <figure key={f.label} className="sig-frame" style={{ maxWidth: f.width }}>
                  <iframe title={`${m.title}, ${f.label.toLowerCase()} width`} srcDoc={m.mail.html} width={f.width} height={f.height} sandbox="allow-same-origin" />
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
