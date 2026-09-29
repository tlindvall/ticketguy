'use client';
import { useState } from 'react';
import { CopyAddress } from './CopyAddress';
import { PaperclipIcon } from './icons';

/**
 * The homepage's "New message" window: a working demonstration, not a form we submit. The visitor edits
 * the subject and body, and the button opens their own email app with exactly that text; nothing reaches
 * us until they press send there. Copying the address is the fallback when no email app opens.
 */
export function ComposeDemo({ address, subject: initialSubject, body: initialBody, cta }: { address: string; subject: string; body: string; cta: string }) {
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const href = `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <form className="compose" aria-label="Write to your ticket guy" onSubmit={(e) => { e.preventDefault(); window.location.href = href; }}>
      <div className="compose-titlebar">New message</div>
      <div className="compose-row">
        <span className="compose-label">To:</span>
        <a className="compose-to" href={`mailto:${address}`}>{address}</a>
      </div>
      <label className="compose-row">
        <span className="compose-label">Subject:</span>
        <input className="compose-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={140} />
      </label>
      <label className="compose-body-wrap">
        <span className="sr-only">Message</span>
        <textarea className="compose-body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} />
      </label>
      <div className="compose-footer">
        <span className="compose-attach"><PaperclipIcon /><span>Links and screenshots welcome</span></span>
        <CopyAddress address={address} />
        <button type="submit" className="btn-lime">{cta} <span aria-hidden="true">›</span></button>
      </div>
    </form>
  );
}
