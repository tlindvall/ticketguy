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

/** What staff can change about the brand signature (Email templates → Brand signature). */
export type BrandLogo = 'badge' | 'mark' | 'none';
export const BRAND_LOGOS: readonly BrandLogo[] = ['badge', 'mark', 'none'];
export type BrandSignature = { displayName: string; tagline: string; shortSignoff: string; logo: BrandLogo };
export const BUILT_IN_BRAND: BrandSignature = { displayName: 'Ticket Guy', tagline: SIGNATURE_TAGLINE, shortSignoff: '— Ticket Guy', logo: 'mark' };

/** Hosted image, displayed size, alt-free (the name beside it is text). */
const LOGO: Record<Exclude<BrandLogo, 'none'>, { file: string; width: number; height: number }> = {
  badge: { file: 'ticket-badge@3x.png', width: 44, height: 44 },
  mark: { file: 'ticket-mark@3x.png', width: 40, height: 32 },
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderSignature(kind: SignatureKind, appUrl: string, brand: BrandSignature = BUILT_IN_BRAND): { text: string; html: string } {
  if (kind === 'short') {
    return { text: brand.shortSignoff, html: `<p style="margin:20px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;">${esc(brand.shortSignoff)}</p>` };
  }
  const logo = brand.logo === 'none' ? null : LOGO[brand.logo];
  const logoCell = logo
    ? `<td valign="top" width="${logo.width + 12}" style="width:${logo.width + 12}px;padding:2px 12px 0 0;"><img src="${esc(`${appUrl.replace(/\/$/, '')}/email/${logo.file}`)}" width="${logo.width}" height="${logo.height}" alt="" style="display:block;border:0;width:${logo.width}px;height:${logo.height}px;"></td>\n    `
    : '';
  return {
    text: [brand.displayName, brand.tagline, SERVICE_URL].filter(Boolean).join('\n'),
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:24px;font-family:Arial,Helvetica,sans-serif;">
  <tr>
    ${logoCell}<td valign="top" style="padding:0;">
      <p style="margin:0 0 3px;font-size:15px;line-height:20px;font-weight:700;color:#142438;">${esc(brand.displayName)}</p>
      ${brand.tagline ? `<p style="margin:0 0 4px;font-size:12px;line-height:18px;color:#536174;">${esc(brand.tagline)}</p>\n      ` : ''}<a href="${esc(SERVICE_URL)}" style="font-size:12px;line-height:18px;color:#142438;text-decoration:underline;">${esc(SERVICE_DOMAIN)}</a>
    </td>
  </tr>
</table>`,
  };
}
