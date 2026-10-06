/**
 * The ticket brief (design package 2026-10-06): a short message from your guy above a compact event-and-ticket card.
 * Presentation only. The packet decides the state from checked facts; this lays them out.
 *
 * Two states reach a customer: a verified offer (lime badge, the seller's exact listing as the one primary action) and
 * a price lead (neutral badge, "estimated" beside the amount, the facts still unchecked named on the card). A lead never
 * says "I'd buy" or "cheapest available", and its marketplace link is a search, never a purchase button.
 *
 * Inline styles and presentation tables only, so the hierarchy holds in clients that drop rounded corners or images.
 * The artwork is decorative (empty alt) and every fact on the card is real text.
 */
import type { BriefArt, MatchupSide } from '@/lib/brand/assets';

export type BriefAlternative = { label: string; totalCents: number; basis: 'before fees' | 'fees included'; note: string };

export type TicketBrief = {
  kind: 'price_lead' | 'verified_offer';
  headline: string;
  rationale: string;
  /** "Concert", "NHL": the small label above the event name. */
  category: string;
  event: { name: string; where: string; when: string };
  /** Hosted https artwork, 3:1; only on a first, substantial reply. Never evidence of the seat or venue. */
  artworkUrl: string | null;
  seatLine: string;
  /** "About $2,651" for a lead, "$2,184" for a checked total. */
  total: string;
  /** "for two" */
  forWhom: string;
  /** What the total is made of. */
  basis: string[];
  facts: Array<[string, string]>;
  action: { label: string; url: string } | null;
  /** The other marketplace's search, as a plain link under the action. */
  secondary: { label: string; url: string } | null;
  actionNote: string;
  affiliate: boolean;
  alternatives: BriefAlternative[];
  after: string[];
  evidenceNote: string;
};

const INK = '#142438';
const MUTED = '#526174';
const CREAM = '#f7f4ec';
const LIME = '#d7f36b';
const NEUTRAL = '#e9e3d8';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const briefDollars = dollars;

const P = (inner: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:25px;color:${INK};">${inner}</p>`;
const label = (text: string) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:17px;letter-spacing:1.1px;font-weight:700;text-transform:uppercase;color:${MUTED};">${esc(text)}</div>`;

/** Only an https image reaches a sent email; anything else is left out, never sent broken. */
function imageUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function button(text: string, url: string, primary: boolean): string {
  const bg = primary ? INK : '#ffffff';
  const color = primary ? '#ffffff' : INK;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="${bg}" style="border-radius:7px;background:${bg};border:1px solid ${INK};text-align:center;"><a href="${esc(url)}" style="display:block;padding:15px 20px;color:${color};font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:20px;font-weight:700;text-decoration:none;">${esc(text)}&nbsp;↗</a></td></tr></table>`;
}

/** The headline and the one-paragraph reason, under the greeting. */
export function briefTop(b: TicketBrief): { text: string[]; html: string[] } {
  return {
    text: [b.headline, b.rationale],
    html: [`<h1 style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:25px;line-height:32px;letter-spacing:-.6px;font-weight:700;color:${INK};">${esc(b.headline)}</h1>`, P(esc(b.rationale))],
  };
}

/**
 * The artwork row from brand/assets.ts: both teams side by side in their colours, a 3:1 image, or a band in a show's
 * colours. Decoration only: every image has an empty alt and the event is named in text below it. Only assets whose
 * rights are approved reach a sent email (loadBriefArt's send mode).
 */
function artRow(art: BriefArt): string {
  // A preview serves its images from this server by path; a sent email's asset URLs are absolute https (APP_URL).
  const src = (u: string | null) => (u && /^\/(?!\/)/.test(u) ? u : imageUrl(u));
  const top = 'border-radius:11px 11px 0 0;';
  if (art.kind === 'image') {
    const url = src(art.url);
    return url ? `<tr><td style="font-size:0;line-height:0;background:${INK};${top}"><img src="${esc(url)}" alt="" role="presentation" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;${top}"></td></tr>` : '';
  }
  if (art.kind === 'band') {
    return `<tr><td bgcolor="${art.color}" style="background:${art.color};padding:30px 24px 26px;${top}"><div style="width:36px;height:4px;background:${art.accent};font-size:0;line-height:0;margin:0 0 12px;">&nbsp;</div><div style="font-size:24px;line-height:30px;font-weight:700;letter-spacing:-.4px;color:${art.textColor};">${esc(art.label)}</div></td></tr>`;
  }
  const cell = (side: MatchupSide, width: string, align: 'left' | 'right', radius: string) => {
    const logoUrl = src(side.logoUrl);
    const logo = logoUrl ? `<img src="${esc(logoUrl)}" alt="" role="presentation" width="56" height="56" style="display:block;width:56px;height:56px;border:0;${align === 'right' ? 'margin-left:auto;' : ''}">` : '';
    const short = side.shortName ? `<div style="font-size:26px;line-height:30px;font-weight:700;letter-spacing:.5px;color:${side.textColor};">${esc(side.shortName)}</div>` : '';
    return `<td width="${width}" align="${align}" bgcolor="${side.color}" style="background:${side.color};padding:20px 20px 18px;vertical-align:middle;${radius}">${logo}${logo && short ? '<div style="height:8px;line-height:8px;font-size:0;">&nbsp;</div>' : ''}${short}<div style="font-size:13px;line-height:18px;color:${side.textColor};">${esc(side.name)}</div></td>`;
  };
  const row = (cells: string) => `<tr><td style="${top}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table></td></tr>`;
  if (!art.right) return row(cell(art.left, '100%', 'left', top));
  const vs = `<td width="44" align="center" bgcolor="${INK}" style="background:${INK};vertical-align:middle;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1px;color:#ffffff;">VS</td>`;
  return row(`${cell(art.left, '46%', 'left', 'border-radius:11px 0 0 0;')}${vs}${cell(art.right, '46%', 'right', 'border-radius:0 11px 0 0;')}`);
}

/**
 * The card, the alternatives and the one trade-off. `withEvent: false` when the email's header already names the event
 * (another answer leads), so it isn't said twice; the artwork goes with the event block.
 */
export function briefCard(b: TicketBrief, opts: { withEvent?: boolean; art?: BriefArt | null } = {}): { text: string[]; html: string[] } {
  const withEvent = opts.withEvent ?? true;
  const lead = b.kind === 'price_lead';
  const status = lead ? 'Price lead · still needs checking' : 'My pick · checkout checked';
  const image = withEvent ? imageUrl(b.artworkUrl) : null;
  const meta = [b.event.where, b.event.when].filter(Boolean);
  const facts = b.facts.map(([k, v]) => `<td width="50%" style="padding:17px 8px 0 0;vertical-align:top;">${label(k)}<div style="font-size:14px;line-height:22px;font-weight:700;color:${INK};">${esc(v)}</div></td>`).join('');
  const card =
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e0e4e4;border-radius:12px;border-collapse:separate;margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;color:${INK};">` +
    // The event's own artwork (teams, show, venue) when there is approved artwork for it; otherwise the generic image.
    (withEvent && opts.art ? artRow(opts.art) : image ? `<tr><td style="font-size:0;line-height:0;background:${INK};border-radius:11px 11px 0 0;"><img src="${esc(image)}" alt="" role="presentation" width="600" height="200" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:11px 11px 0 0;"></td></tr>` : '') +
    (withEvent
      ? `<tr><td style="padding:24px 24px 22px;">${label(`${b.category} / Your ticket brief`)}` +
        `<h2 style="margin:6px 0 6px;font-size:24px;line-height:31px;letter-spacing:-.5px;font-weight:700;color:${INK};">${esc(b.event.name)}</h2>` +
        (meta.length ? `<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">${meta.map(esc).join('<br>')}</p>` : '') +
        `</td></tr>` +
        `<tr><td style="padding:0 24px;"><div style="border-top:1px dashed #cbd2d3;height:1px;line-height:1px;font-size:0;">&nbsp;</div></td></tr>`
      : '') +
    `<tr><td style="padding:22px 24px 24px;background:${CREAM};border-radius:${withEvent ? '0 0 11px 11px' : '11px'};">` +
    `<span style="display:inline-block;background:${lead ? NEUTRAL : LIME};color:${INK};padding:5px 9px;border-radius:4px;font-size:11px;line-height:17px;font-weight:700;">${esc(status)}</span>` +
    `<div style="margin-top:16px;font-size:16px;line-height:24px;font-weight:700;">${esc(b.seatLine)}</div>` +
    `<div style="margin-top:5px;font-size:32px;line-height:40px;font-weight:700;letter-spacing:-1px;">${esc(b.total)} <span style="font-size:16px;line-height:24px;font-weight:400;letter-spacing:0;">${esc(b.forWhom)}</span></div>` +
    `<p style="margin:5px 0 0;color:${MUTED};font-size:13px;line-height:21px;">${b.basis.map(esc).join('<br>')}${lead ? '<br><b>Estimated total; checkout price unconfirmed.</b>' : ''}</p>` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>${facts}</tr></table>` +
    (b.action ? `<div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>${button(b.action.label, b.action.url, !lead)}` : '') +
    (b.secondary ? `<p style="margin:12px 0 0;font-size:14px;line-height:21px;text-align:center;"><a href="${esc(b.secondary.url)}" style="color:${INK};text-decoration:underline;font-weight:700;">${esc(b.secondary.label)}</a></p>` : '') +
    `<p style="margin:10px 0 0;color:${MUTED};font-size:12px;line-height:18px;">${esc(b.actionNote)}</p>` +
    (b.affiliate ? `<p style="margin:6px 0 0;color:${MUTED};font-size:12px;line-height:18px;">I may earn a commission if you buy through this link.</p>` : '') +
    `</td></tr></table>`;
  const html = [card];
  const text = [
    ...(withEvent ? [[b.event.name, ...meta].join('\n')] : []),
    [status, b.seatLine, `${b.total} ${b.forWhom}`, ...b.basis, ...(lead ? ['Estimated total; checkout price unconfirmed.'] : []), ...b.facts.map(([k, v]) => `${k}: ${v}`)].join('\n'),
    [...(b.action ? [`${b.action.label}: ${b.action.url}`] : []), ...(b.secondary ? [`${b.secondary.label}: ${b.secondary.url}`] : []), b.actionNote, ...(b.affiliate ? ['I may earn a commission if you buy through this link.'] : [])].join('\n'),
  ];
  const alts = b.alternatives.slice(0, 2);
  if (alts.length) {
    const head = lead ? 'Other price leads' : 'What else I checked';
    const rows = alts
      .map(
        (a) =>
          `<tr><td style="padding:13px 0;border-bottom:1px solid #e5e8e8;font-size:14px;line-height:21px;color:${INK};"><b>${esc(a.label)}</b><br><span style="color:${MUTED};">${esc(a.note)}</span></td>` +
          `<td align="right" style="padding:13px 0;border-bottom:1px solid #e5e8e8;font-size:15px;line-height:21px;white-space:nowrap;vertical-align:top;color:${INK};"><b>${dollars(a.totalCents)}</b><br><span style="color:${MUTED};font-size:12px;">${esc(a.basis)}</span></td></tr>`,
      )
      .join('');
    html.push(`<div style="padding:20px 0 18px;font-family:Arial,Helvetica,sans-serif;">${label(head)}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table></div>`);
    text.push([head, ...alts.map((a) => `${a.label}: ${dollars(a.totalCents)} ${a.basis}. ${a.note}`)].join('\n'));
  } else html.push('<div style="height:18px;line-height:18px;font-size:0;">&nbsp;</div>');
  for (const a of b.after) {
    html.push(P(esc(a)));
    text.push(a);
  }
  return { text, html };
}

/** Where the numbers came from and what isn't checked, in small print at the end. */
export function briefEvidence(b: TicketBrief): { text: string; html: string } {
  return { text: b.evidenceNote, html: `<p style="margin:0 0 16px;font-size:12px;line-height:18px;color:${MUTED};">${esc(b.evidenceNote)}</p>` };
}
