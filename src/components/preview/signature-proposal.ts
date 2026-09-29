import { SIGNATURE_TAGLINE } from '@/lib/email/signature';

/**
 * Brand direction 01's email signature, as the HTML we would send, for review only: nothing here is wired
 * into outgoing email (live signatures are src/lib/email/signature.ts).
 *
 * The email stays an ordinary personal email: readable sans-serif text, then a small signature. Against
 * the live one: the mark is about 30% smaller (28 by 22 instead of 40 by 32), the address replaces the web
 * address because email is how people reach us, and it links in the brand's link blue. The mark is the
 * existing hosted PNG of the ticket SVG, because Gmail and Outlook don't render SVG. The name is real text,
 * so it still reads with images off. There is no separate sign-off line above it: the name is the sign-off,
 * so "Ticket Guy" isn't said twice, and nothing uses a dash.
 */
const INK = '#142438';
const MUTED = '#536174';
const LINK = '#2563EB';
const MARK = { file: 'ticket-mark@3x.png', width: 28, height: 22 };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function proposedSignature(a: { appUrl: string; address: string; name?: string; tagline?: string }): { text: string; html: string } {
  const name = a.name ?? 'Ticket Guy';
  const tagline = a.tagline ?? SIGNATURE_TAGLINE;
  const src = `${a.appUrl.replace(/\/$/, '')}/email/${MARK.file}`;
  return {
    text: [name, tagline, a.address].join('\n'),
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:28px;font-family:Arial,Helvetica,sans-serif;">
  <tr>
    <td valign="top" width="${MARK.width + 12}" style="width:${MARK.width + 12}px;padding:1px 12px 0 0;"><img src="${esc(src)}" width="${MARK.width}" height="${MARK.height}" alt="" style="display:block;border:0;width:${MARK.width}px;height:${MARK.height}px;"></td>
    <td valign="top" style="padding:0;">
      <p style="margin:0 0 2px;font-size:14px;line-height:19px;font-weight:700;color:${INK};">${esc(name)}</p>
      <p style="margin:0 0 2px;font-size:12px;line-height:17px;color:${MUTED};">${esc(tagline)}</p>
      <a href="mailto:${esc(a.address)}" style="font-size:12px;line-height:17px;color:${LINK};text-decoration:underline;">${esc(a.address)}</a>
    </td>
  </tr>
</table>`,
  };
}

const DISCLOSURE = 'AI-assisted ticket advice.';

/**
 * A whole email as the customer's client would get it: the first reply in a conversation carries the
 * signature; a follow-up in the same thread signs with the name alone, as today.
 */
export function proposedEmail(a: { appUrl: string; address: string; paragraphs: string[]; followUp?: boolean }): { text: string; html: string } {
  const sig = a.followUp
    ? { text: 'Ticket Guy', html: `<p style="margin:22px 0 0;font-size:15px;line-height:23px;color:${INK};">Ticket Guy</p>` }
    : proposedSignature(a);
  const paras = a.paragraphs.map((p) => `<p style="margin:0 0 14px;">${esc(p)}</p>`).join('');
  return {
    text: [...a.paragraphs, sig.text, DISCLOSURE].join('\n\n'),
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:20px 22px;background:#ffffff;"><div style="max-width:600px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;color:${INK};">${paras}${sig.html}<p style="margin:22px 0 0;font-size:11px;line-height:16px;color:#6b7280;">${DISCLOSURE}</p></div></body></html>`,
  };
}
