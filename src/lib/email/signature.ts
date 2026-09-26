import { SERVICE_DOMAIN, SERVICE_URL } from '@/lib/config/brand';

/**
 * The Ticket Guy email signature (owner-supplied design, ticket-guy-signature package).
 *
 * The full signature — mark, name, tagline, site — goes on the first reply in a conversation; follow-ups
 * sign off "— Ticket Guy" so the branding does not stack down a thread. The name and tagline are real text,
 * so a client that blocks images still shows who wrote. The mark is served over https from the app itself
 * (public/email) rather than attached: an inline attachment shows up as a paperclip in several clients, and
 * a hosted PNG degrades to the text beside it when images are off.
 */
export type SignatureKind = 'full' | 'short';

export const SIGNATURE_TAGLINE = 'Your second opinion before you buy.';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderSignature(kind: SignatureKind, appUrl: string): { text: string; html: string } {
  if (kind === 'short') {
    return { text: '— Ticket Guy', html: '<p style="margin:20px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;">— Ticket Guy</p>' };
  }
  const logo = `${appUrl.replace(/\/$/, '')}/email/ticket-mark@3x.png`;
  return {
    text: `Ticket Guy\n${SIGNATURE_TAGLINE}\n${SERVICE_URL}`,
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:24px;font-family:Arial,Helvetica,sans-serif;">
  <tr>
    <td valign="top" width="52" style="width:52px;padding:2px 12px 0 0;"><img src="${esc(logo)}" width="40" height="32" alt="" style="display:block;border:0;width:40px;height:32px;"></td>
    <td valign="top" style="padding:0;">
      <p style="margin:0 0 3px;font-size:15px;line-height:20px;font-weight:700;color:#142438;">Ticket Guy</p>
      <p style="margin:0 0 4px;font-size:12px;line-height:18px;color:#536174;">${esc(SIGNATURE_TAGLINE)}</p>
      <a href="${esc(SERVICE_URL)}" style="font-size:12px;line-height:18px;color:#142438;text-decoration:underline;">${esc(SERVICE_DOMAIN)}</a>
    </td>
  </tr>
</table>`,
  };
}
