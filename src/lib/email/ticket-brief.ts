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
export type BriefAlternative = { label: string; totalCents: number; basis: 'before fees' | 'fees included'; note: string; /** Per ticket, on the same basis. */ eachCents?: number | null };

/**
 * How the price has moved (live Oct 9: "this is the product"): the cheapest listed price for their basis three days
 * ago, yesterday and now, oldest first, the same quantity and fee basis on every row. Past movement only, from the
 * same resale series the packet reads. What it means is said once, in the words above the card, not again here.
 */
export type BriefTrend = {
  direction: 'up' | 'down' | 'flat' | 'mixed';
  /** The badge for a mixed series, in words ("Dip reversed"); null uses the direction's own. */
  badge?: string | null;
  /** Oldest first, ending with now; each only when the series has it. */
  rows: Array<{ label: string; cents: number }>;
  /** "The cheapest listed pair, before fees, from StubHub and Vivid Seats." */
  basis: string;
};

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
  /** Beside the party: "estimated fees included". */
  totalNote?: string | null;
  /** The price a ticket, said plainly under the total ("About $920 a ticket, with fees"); null for one ticket. */
  each?: string | null;
  /** What the total is made of. */
  basis: string[];
  facts: Array<[string, string]>;
  action: { label: string; url: string } | null;
  /** The other marketplace's search, as a plain link under the action. */
  secondary: { label: string; url: string } | null;
  /** With no action button (we don't know the seller, or the advice is to hold off): the seller links, as plain links. */
  links?: Array<{ label: string; url: string }>;
  /** Short paragraphs under the rationale: which way prices have moved, what past games did. */
  points?: string[];
  /** Holding off with a watch that can start: the next step, in place of a seller's button. */
  watch?: { title: string; body: string } | null;
  actionNote: string;
  affiliate: boolean;
  alternatives: BriefAlternative[];
  /** Shown under the card whenever the resale series can say it. */
  trend?: BriefTrend | null;
  after: string[];
  evidenceNote: string;
};

const INK = '#142438';
const MUTED = '#526174';
const CREAM = '#f7f4ec';
const LIME = '#d7f36b';
const NEUTRAL = '#e9e3d8';
// For someone buying, a rise is the bad news and a fall the good: the colours say it before the words do.
const RISE = '#b42318';
const FALL = '#1d7a3e';
const TREND_BADGE = { up: ['#fde4df', '▲ Rising'], down: ['#dcf1e3', '▼ Falling'], flat: [NEUTRAL, '● Steady'], mixed: [NEUTRAL, '◆ Both ways'] } as const;

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

/**
 * The verdict, the price with its caveat, which way prices have moved and what past games did, then the movement as a
 * small table: everything that decides it, above the card and its artwork (live Oct 9 review: "understood in five seconds").
 */
export function briefTop(b: TicketBrief): { text: string[]; html: string[] } {
  const points = b.points ?? [];
  const trend = b.trend ? briefTrend(b.trend) : null;
  return {
    text: [b.headline, b.rationale, ...points, ...(trend ? [trend.text] : [])],
    html: [`<h1 style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:25px;line-height:32px;letter-spacing:-.6px;font-weight:700;color:${INK};">${esc(b.headline)}</h1>`, P(esc(b.rationale)), ...points.map((x) => P(esc(x))), ...(trend ? [trend.html] : [])],
  };
}

/**
 * The card, the alternatives and the one trade-off. `withEvent: false` when the email's header already names the event
 * (another answer leads), so it isn't said twice; the artwork goes with the event block.
 */
export function briefCard(b: TicketBrief, opts: { withEvent?: boolean; trend?: boolean } = {}): { text: string[]; html: string[] } {
  const withEvent = opts.withEvent ?? true;
  const lead = b.kind === 'price_lead';
  const status = lead ? 'Price lead · still needs checking' : 'My pick · checkout checked';
  const image = withEvent ? imageUrl(b.artworkUrl) : null;
  const meta = [b.event.where, b.event.when].filter(Boolean);
  const facts = b.facts.map(([k, v]) => `<td width="50%" style="padding:17px 8px 0 0;vertical-align:top;">${label(k)}<div style="font-size:14px;line-height:22px;font-weight:700;color:${INK};">${esc(v)}</div></td>`).join('');
  const card =
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e0e4e4;border-radius:12px;border-collapse:separate;margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;color:${INK};">` +
    // Branding, kept small: the decision, price and trend are above the card, not pushed under a banner.
    (image ? `<tr><td style="padding:20px 24px 0;font-size:0;line-height:0;"><img src="${esc(image)}" alt="" role="presentation" width="300" height="100" style="display:block;width:300px;max-width:100%;height:auto;border:0;border-radius:8px;"></td></tr>` : '') +
    (withEvent
      ? `<tr><td style="padding:${image ? '16px' : '24px'} 24px 22px;">${label(`${b.category} / Your ticket brief`)}` +
        `<h2 style="margin:6px 0 6px;font-size:24px;line-height:31px;letter-spacing:-.5px;font-weight:700;color:${INK};">${esc(b.event.name)}</h2>` +
        (meta.length ? `<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">${meta.map(esc).join('<br>')}</p>` : '') +
        `</td></tr>` +
        `<tr><td style="padding:0 24px;"><div style="border-top:1px dashed #cbd2d3;height:1px;line-height:1px;font-size:0;">&nbsp;</div></td></tr>`
      : '') +
    `<tr><td style="padding:22px 24px 24px;background:${CREAM};border-radius:${withEvent ? '0 0 11px 11px' : '11px'};">` +
    `<span style="display:inline-block;background:${lead ? NEUTRAL : LIME};color:${INK};padding:5px 9px;border-radius:4px;font-size:11px;line-height:17px;font-weight:700;">${esc(status)}</span>` +
    `<div style="margin-top:16px;font-size:16px;line-height:24px;font-weight:700;">${esc(b.seatLine)}</div>` +
    `<div style="margin-top:5px;font-size:32px;line-height:40px;font-weight:700;letter-spacing:-1px;">${esc(b.total)} <span style="font-size:16px;line-height:24px;font-weight:400;letter-spacing:0;">${esc(b.forWhom)}${b.totalNote ? ` · ${esc(b.totalNote)}` : ''}</span></div>` +
    (b.each ? `<div style="margin-top:2px;font-size:${b.totalNote ? '14px' : '18px'};line-height:22px;font-weight:${b.totalNote ? '400' : '700'};color:${b.totalNote ? MUTED : INK};">${esc(b.each)}</div>` : '') +
    `<p style="margin:5px 0 0;color:${MUTED};font-size:13px;line-height:21px;">${b.basis.map(esc).join('<br>')}${lead && !b.totalNote ? '<br><b>Estimated total; checkout price unconfirmed.</b>' : ''}</p>` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>${facts}</tr></table>` +
    (b.watch ? `<div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="background:#ffffff;border:1px solid ${INK};border-radius:7px;padding:14px 16px;"><div style="font-size:15px;line-height:21px;font-weight:700;color:${INK};">${esc(b.watch.title)}</div><div style="margin-top:4px;font-size:14px;line-height:21px;color:${INK};">${esc(b.watch.body)}</div></td></tr></table>` : '') +
    (b.action ? `<div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>${button(b.action.label, b.action.url, !lead)}` : '') +
    (b.secondary ? `<p style="margin:12px 0 0;font-size:14px;line-height:21px;text-align:center;"><a href="${esc(b.secondary.url)}" style="color:${INK};text-decoration:underline;font-weight:700;">${esc(b.secondary.label)}</a></p>` : '') +
    (b.links?.length ? `<p style="margin:${b.watch ? '12px' : '18px'} 0 0;font-size:14px;line-height:22px;">${b.links.map((l) => `<a href="${esc(l.url)}" style="color:${INK};text-decoration:underline;font-weight:700;">${esc(l.label)}</a>`).join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</p>` : '') +
    `<p style="margin:10px 0 0;color:${MUTED};font-size:12px;line-height:18px;">${esc(b.actionNote)}</p>` +
    (b.affiliate ? `<p style="margin:6px 0 0;color:${MUTED};font-size:12px;line-height:18px;">I may earn a commission if you buy through this link.</p>` : '') +
    `</td></tr></table>`;
  const html = [card];
  const text = [
    ...(withEvent ? [[b.event.name, ...meta].join('\n')] : []),
    [status, b.seatLine, `${b.total} ${b.forWhom}${b.totalNote ? ` · ${b.totalNote}` : ''}`, ...(b.each ? [b.each] : []), ...b.basis, ...(lead && !b.totalNote ? ['Estimated total; checkout price unconfirmed.'] : []), ...b.facts.map(([k, v]) => `${k}: ${v}`)].join('\n'),
    [...(b.watch ? [`${b.watch.title} ${b.watch.body}`] : []), ...(b.action ? [`${b.action.label}: ${b.action.url}`] : []), ...(b.secondary ? [`${b.secondary.label}: ${b.secondary.url}`] : []), ...(b.links ?? []).map((l) => `${l.label}: ${l.url}`), b.actionNote, ...(b.affiliate ? ['I may earn a commission if you buy through this link.'] : [])].join('\n'),
  ];
  if (b.trend && opts.trend !== false) {
    const t = briefTrend(b.trend);
    html.push(t.html);
    text.push(t.text);
  }
  const alts = b.alternatives.slice(0, 2);
  if (alts.length) {
    const head = lead ? 'Other price leads' : 'What else I checked';
    const rows = alts
      .map(
        (a) =>
          `<tr><td style="padding:13px 0;border-bottom:1px solid #e5e8e8;font-size:14px;line-height:21px;color:${INK};"><b>${esc(a.label)}</b><br><span style="color:${MUTED};">${esc(a.note)}</span></td>` +
          `<td align="right" style="padding:13px 0;border-bottom:1px solid #e5e8e8;font-size:15px;line-height:21px;white-space:nowrap;vertical-align:top;color:${INK};"><b>${dollars(a.totalCents)}</b><br><span style="color:${MUTED};font-size:12px;">${a.eachCents ? `${dollars(a.eachCents)} each · ` : ''}${esc(a.basis)}</span></td></tr>`,
      )
      .join('');
    html.push(`<div style="padding:20px 0 18px;font-family:Arial,Helvetica,sans-serif;">${label(head)}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table></div>`);
    text.push([head, ...alts.map((a) => `${a.label}: ${dollars(a.totalCents)} ${a.basis}${a.eachCents ? ` (${dollars(a.eachCents)} each)` : ''}. ${a.note}`)].join('\n'));
  } else html.push('<div style="height:18px;line-height:18px;font-size:0;">&nbsp;</div>');
  for (const a of b.after) {
    html.push(P(esc(a)));
    text.push(a);
  }
  return { text, html };
}

/** "▼ $90 on 3 days ago", "≈ same": each row against the one before it, on the arrow's colour. */
function step(prev: number, cur: number): { short: string; color: string } {
  const d = cur - prev;
  // The live trend's rule (series.ts): 5% and $3 a ticket; here on the whole basis, so the cents are scaled by rows' size.
  if (Math.abs(d) < 300 || Math.abs(d) / prev < 0.05) return { short: '≈ same', color: MUTED };
  return { short: `${d > 0 ? '▲' : '▼'} ${dollars(Math.abs(d))}`, color: d > 0 ? RISE : FALL };
}

/** The price-movement table: oldest first, ending with now, each against the row before it; what it means is said above. */
export function briefTrend(t: BriefTrend): { text: string; html: string } {
  const [bg, fallback] = TREND_BADGE[t.direction];
  const word = t.badge ? `◆ ${t.badge}` : fallback;
  const rows = t.rows.map((r) => ({ ...r, cents: Math.round(r.cents / 100) * 100 }));
  const cells = rows
    .map((r, i) => {
      const last = i === rows.length - 1;
      const s = i ? step(rows[i - 1]!.cents, r.cents) : null;
      return (
        `<td width="${Math.floor(100 / rows.length)}%" style="padding:12px ${last ? '0' : '12px'} 12px ${i ? '12px' : '0'};vertical-align:top;${i ? 'border-left:1px solid #e0e4e4;' : ''}">${label(r.label)}` +
        `<div style="margin-top:2px;font-size:${last ? '24px' : '20px'};line-height:30px;font-weight:700;letter-spacing:-.5px;color:${INK};">${esc(dollars(r.cents))}</div>` +
        (s ? `<div style="font-size:13px;line-height:19px;font-weight:700;color:${s.color};">${esc(s.short)}</div>` : '') +
        `</td>`
      );
    })
    .join('');
  const html =
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e0e4e4;border-radius:12px;border-collapse:separate;margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;color:${INK};"><tr><td style="padding:16px 20px 14px;">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="vertical-align:middle;">${label('How prices are moving')}</td>` +
    `<td align="right" style="vertical-align:middle;"><span style="display:inline-block;background:${bg};color:${INK};padding:4px 9px;border-radius:4px;font-size:12px;line-height:17px;font-weight:700;white-space:nowrap;">${esc(word)}</span></td></tr></table>` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:6px;"><tr>${cells}</tr></table>` +
    `<p style="margin:4px 0 0;font-size:12px;line-height:18px;color:${MUTED};">${esc(t.basis)}</p>` +
    `</td></tr></table>`;
  const text = [`How prices are moving: ${word.slice(2).toLowerCase()}`, ...rows.map((r, i) => `${r.label}: ${dollars(r.cents)}${i ? ` (${step(rows[i - 1]!.cents, r.cents).short})` : ''}`), t.basis].join('\n');
  return { text, html };
}

// "vs.", "St. Louis", "Mt. Hood", "J. Cole", "U.S." end no sentence.
const NOT_AN_END = /(?:^|\s)(?:vs|v|st|mt|ft|jr|sr|dr|mr|mrs|ms|no|feat|[a-z]|(?:[a-z]\.)+[a-z])$/i;
/** The text's first sentence and the rest: a stop, "!" or "?" before a space and a capital, a digit or a quote. */
export function firstSentence(text: string): [string, string] {
  const re = /[.!?](?=\s+["“'‘A-Z0-9$])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '.' && NOT_AN_END.test(text.slice(0, m.index))) continue;
    return [text.slice(0, m.index + 1), text.slice(m.index + 1).trim()];
  }
  return [text, ''];
}

/**
 * The answer as the brief's headline (design package 2026-10-06, carried to every answer on Oct 10): its first sentence
 * in large type and the rest under it, so a ranked list, a verdict on their listing or a buy-or-wait answer reads the
 * same way as named seats. The plain text is the same sentence, unchanged.
 */
export function briefHeadline(text: string): string {
  const [head, rest] = firstSentence(text.trim());
  return briefHeadlineHtml(esc(head), rest ? esc(rest) : '');
}
/** The same headline from markup already escaped (a link in it). */
export function briefHeadlineHtml(head: string, rest = ''): string {
  // A verdict can run to two lines of reasons; at 25px that is a wall, so a long one steps down a size.
  const long = head.replace(/<[^>]+>/g, '').length > 110;
  return `<h1 style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:${long ? '20px' : '25px'};line-height:${long ? '28px' : '32px'};letter-spacing:${long ? '-.3px' : '-.6px'};font-weight:700;color:${INK};">${head}</h1>${rest ? P(rest) : ''}`;
}

/**
 * The event on its own card when no seats are named (their listing judged, a buy-or-wait answer): the banner on the
 * first reply, the kind of event, its name, and where and when, the same block as the brief's card above its price.
 */
export function eventCard(e: { category: string; name: string; details: string; artworkUrl: string | null; action?: { label: string; url: string } | null }): string {
  const image = imageUrl(e.artworkUrl);
  return (
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e0e4e4;border-radius:12px;border-collapse:separate;margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;color:${INK};">` +
    (image ? `<tr><td style="padding:20px 24px 0;font-size:0;line-height:0;"><img src="${esc(image)}" alt="" role="presentation" width="300" height="100" style="display:block;width:300px;max-width:100%;height:auto;border:0;border-radius:8px;"></td></tr>` : '') +
    `<tr><td style="padding:${image ? '16px' : '22px'} 24px 20px;">${label(`${e.category} / Your ticket brief`)}` +
    `<h2 style="margin:6px 0 6px;font-size:22px;line-height:29px;letter-spacing:-.4px;font-weight:700;color:${INK};">${esc(e.name)}</h2>` +
    `<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">${esc(e.details)}</p>` +
    (e.action ? `<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>${button(e.action.label, e.action.url, true)}` : '') +
    `</td></tr></table>`
  );
}

/**
 * One game or show from a list we send (the ranked games, browse picks) as a card: the banner when we hold one, when
 * and what kind, the name linked to its page, where, its price when we hold one, why it fits, and the page as a
 * button. Every fact is the list line's own; nothing is added that the plain text doesn't say.
 */
export type ListCard = { when: string; title: string; url: string | null; where: string | null; price: string | null; priceNote: string | null; reason: string | null; links: Array<{ label: string; url: string }>; badge?: string | null; artworkUrl?: string | null; category?: string | null };
export function listCard(c: ListCard): string {
  const image = imageUrl(c.artworkUrl ?? null);
  const title = c.url ? `<a href="${esc(c.url)}" style="color:${INK};text-decoration:none;">${esc(c.title)}</a>` : esc(c.title);
  const page = c.links.find((l) => /event page/i.test(l.label)) ?? null;
  const others = c.links.filter((l) => l !== page);
  return (
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e0e4e4;border-radius:12px;border-collapse:separate;margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;color:${INK};">` +
    (image ? `<tr><td style="padding:18px 22px 0;font-size:0;line-height:0;"><img src="${esc(image)}" alt="" role="presentation" width="300" height="100" style="display:block;width:300px;max-width:100%;height:auto;border:0;border-radius:8px;"></td></tr>` : '') +
    `<tr><td style="padding:${image ? '14px' : '18px'} 22px 18px;">` +
    (c.badge ? `<span style="display:inline-block;background:${LIME};color:${INK};padding:4px 8px;border-radius:4px;font-size:11px;line-height:16px;font-weight:700;margin:0 0 8px;">${esc(c.badge)}</span>` : '') +
    label([c.category, c.when].filter(Boolean).join(' · ')) +
    `<h3 style="margin:5px 0 4px;font-size:19px;line-height:26px;letter-spacing:-.3px;font-weight:700;color:${INK};">${title}</h3>` +
    (c.where ? `<p style="margin:0;font-size:14px;line-height:21px;color:${MUTED};">${esc(c.where)}</p>` : '') +
    (c.price ? `<div style="margin-top:10px;font-size:24px;line-height:30px;font-weight:700;letter-spacing:-.6px;">${esc(c.price)}${c.priceNote ? ` <span style="font-size:14px;line-height:21px;font-weight:400;letter-spacing:0;color:${MUTED};">${esc(c.priceNote)}</span>` : ''}</div>` : '') +
    (c.reason ? `<p style="margin:10px 0 0;font-size:14px;line-height:21px;color:${INK};">${esc(c.reason)}</p>` : '') +
    (page ? `<div style="height:14px;line-height:14px;font-size:0;">&nbsp;</div>${button(page.label, page.url, false)}` : '') +
    (others.length ? `<p style="margin:10px 0 0;font-size:14px;line-height:21px;">${others.map((l) => `<a href="${esc(l.url)}" style="color:${INK};text-decoration:underline;font-weight:700;">${esc(l.label)}</a>`).join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</p>` : '') +
    `</td></tr></table>`
  );
}

/** Where the numbers came from and what isn't checked, in small print at the end. */
export function briefEvidence(b: TicketBrief): { text: string; html: string } {
  return { text: b.evidenceNote, html: `<p style="margin:0 0 16px;font-size:12px;line-height:18px;color:${MUTED};">${esc(b.evidenceNote)}</p>` };
}
