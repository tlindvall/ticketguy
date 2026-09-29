import { isSlotName, renderAuthored, type SlotName, type TemplateOverrides, type TemplateValue } from './custom-templates';
import { renderSignature, type BrandSignature, type SignatureKind } from './signature';
import { AFFILIATE_DISCLOSURE } from './links';
import { noDashes } from './punctuation';

/**
 * Bounded email templates (API_AND_DATA_CONTRACTS §6). Text + HTML, escaped user text, no invented availability.
 * Recommendation bodies come pre-rendered from the advice renderer ('raw').
 *
 * A slot may be overridden by staff-authored copy (see custom-templates.ts). The override replaces the body
 * only: the sign-off, the signature and the disclosure are appended here, so no template can drop them, and
 * 'raw' is never overridable because that copy carries the offer evidence rules.
 *
 * Layout is a plain left-aligned email, not a centred newsletter column. The disclosure says only what is
 * true of that message: automatic replies are "AI-assisted"; "human-reviewed" is reserved for the messages a
 * person approved before they went out (recommendations and watch alerts).
 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const REVIEWED_FOOTER = 'Ticket Guy is AI-assisted and human-reviewed. We compare options and link you to the seller; we never buy, hold or resell tickets. Reply to this email any time.';
const AUTOMATED_FOOTER = 'AI-assisted ticket advice.';
/** Templates that are only ever sent after a person approved that exact message. */
const REVIEWED_TEMPLATES: ReadonlySet<string> = new Set(['raw', 'watch_alert']);
const disclosureFor = (name: string) => (REVIEWED_TEMPLATES.has(name) ? REVIEWED_FOOTER : AUTOMATED_FOOTER);

const BODY_OPEN = '<!doctype html><html><body style="margin:0;padding:0;"><div style="max-width:640px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#202124;">';
const BODY_CLOSE = '</div></body></html>';
const disclosureHtml = (text: string) => `<p style="margin:16px 0 0;font-size:11px;line-height:17px;color:#666;">${esc(text)}</p>`;
const para = (text: string) => `<p style="margin:0 0 18px;">${esc(text)}</p>`;

type Pick = { line: string; title: string; reason: string; eventUrl: string | null; links: Array<{ label: string; url: string }> };

/** An inline link, the way a person writes one in an email: underlined text, no buttons or boxes. */
function link(label: string, url: string, bold = false): string {
  return `<a href="${esc(url)}" style="color:#142438;text-decoration:underline;${bold ? 'font-weight:700;' : ''}">${esc(label)}</a>`;
}

/**
 * One pick as a line of an ordinary list: the date, the title linked to its event page, the venue, a few words
 * on why, then its links inline ("Listen · Tickets").
 */
function pickHtml(p: Pick): string {
  const [when, ...rest] = p.line.split(': ');
  const after = rest.join(': ');
  const i = after.indexOf(p.title);
  const titled = i >= 0 ? `${esc(after.slice(0, i))}${p.eventUrl ? link(p.title, p.eventUrl, true) : `<strong>${esc(p.title)}</strong>`}${esc(after.slice(i + p.title.length))}` : esc(after);
  const links = p.links.map((l) => link(l.label, l.url)).join(' · ');
  return `<li style="margin:0 0 10px;">${esc(when ?? '')}: ${titled}.${p.reason ? ` ${esc(p.reason)}` : ''}${links ? ` ${links}` : ''}</li>`;
}

/** The Resident Advisor pointer for electronic music: a sentence and a plain link to the city's RA page. */
type Ra = { lead: string; label: string; url: string };
const raText = (r: Ra) => `${r.lead} ${r.label}: ${r.url}`;
const raHtml = (r: Ra) => `<p style="margin:0 0 18px;">${esc(r.lead)} ${link(r.label, r.url)}</p>`;

function pickText(p: Pick): string {
  return [`• ${p.line}.${p.reason ? ` ${p.reason}` : ''}`, ...p.links.map((l) => `  ${l.label}: ${l.url}`)].join('\n');
}

/** The eligibility question, asked once, on its own line rather than as one of the request questions. */
/** A notice, not a question: nothing to answer unless it doesn't apply. The customer's own words set their country. */
export const COUNTRY_CHECK_LINE = "Ticket Guy is for US-based fans for now, so if you're outside the US, just let me know.";

/** Maps the pipeline's variables onto the names staff author against. */
function authoringVars(slot: SlotName, v: Record<string, TemplateValue>): Record<string, TemplateValue> {
  if (slot !== 'watch_alert') return v;
  const total = Number(v.totalCents ?? 0);
  return { ...v, priceTotal: `$${(total / 100).toFixed(total % 100 === 0 ? 0 : 2)}` };
}

/**
 * Every customer email body, with no em or en dashes (see punctuation.ts), greeting the customer by name when
 * we know it: the opening "Hey," of any template, staff wording and advice bodies included, becomes "Hey Tobias,".
 */
export function renderTemplate(...args: Parameters<typeof renderBody>): { text: string; html: string } {
  const r = renderBody(...args);
  const name = typeof args[1]?.firstName === 'string' && /^[A-Za-z][A-Za-z'’-]{1,19}$/.test(args[1].firstName) ? args[1].firstName : null;
  const text = name ? r.text.replace(/^Hey,/, `Hey ${name},`) : r.text;
  const html = name ? r.html.replace(/(<p[^>]*>)Hey,(<\/p>)/, `$1Hey ${name},$2`) : r.html;
  return { text: noDashes(text), html: noDashes(html) };
}

function renderBody(
  name: string,
  vars: Record<string, unknown>,
  ctx: { appUrl: string; postalAddress: string | null; overrides?: TemplateOverrides; signature?: SignatureKind; brand?: BrandSignature },
): { text: string; html: string } {
  const v = vars as Record<string, string | string[] | boolean | number | null | undefined>;
  const slot: SlotName | null = isSlotName(name) ? name : null;
  const override = slot ? ctx.overrides?.[slot] : undefined;
  const disclosure = disclosureFor(name);
  const defaultSig = renderSignature(ctx.signature ?? 'short', ctx.appUrl, ctx.brand);
  if (slot && override) {
    const body = renderAuthored(override.body, authoringVars(slot, v));
    const sig = override.signature ? renderAuthored(override.signature, {}) : defaultSig;
    return {
      text: [body.text, sig.text, disclosure].filter(Boolean).join('\n\n'),
      html: `${BODY_OPEN}${body.html}\n${sig.html}${disclosureHtml(disclosure)}${BODY_CLOSE}`,
    };
  }
  const wrap = (paras: string[], htmlParas: string[]) => ({
    text: [...paras, defaultSig.text, disclosure].join('\n\n'), // the empty entry left a double gap before the sign-off
    html: `${BODY_OPEN}${htmlParas.join('\n')}${defaultSig.html}${disclosureHtml(disclosure)}${BODY_CLOSE}`,
  });
  const list = (items: string[]) => items.map((i) => `• ${i}`).join('\n');
  switch (name) {
    case 'acknowledgment': {
      const known = (v.knownFacts as string[]) ?? [];
      const assumed = (v.assumptions as string[] | undefined) ?? [];
      // A person's quick note back: what I have, laid out; what I'll do next. It promises no prices and no review.
      const intro = known.length ? "Got it. Here's what I have:" : `Got it. I'm looking into ${String(v.eventLabel ?? 'your request')}.`;
      const next = "I'll look at how the tickets are trading and come back to you shortly. If anything above is off, just reply.";
      const country = v.countryUnconfirmed ? COUNTRY_CHECK_LINE : '';
      const paras = ['Hey,', known.length ? `${intro}\n${list(known)}` : intro, ...assumed, next, country].filter(Boolean);
      const html = [para('Hey,'), para(intro), known.length ? `<ul style="margin:0 0 18px;padding-left:20px;">${known.map((k) => `<li style="margin:0 0 4px;">${esc(k)}</li>`).join('')}</ul>` : '', ...assumed.map(para), para(next), country ? para(country) : ''].filter(Boolean);
      return wrap(paras, html);
    }
    case 'clarification': {
      // One sentence saying what we understood, then the questions that decide it, one per line. Headings
      // like "What we have so far" / "Could you tell us" made a two-line question read like a form.
      const qs = (v.questions as string[]) ?? [];
      const paras = [
        'Hey,',
        v.acknowledgement ? String(v.acknowledgement) : 'Thanks for getting in touch.',
        v.eventNote ? String(v.eventNote) : '',
        ...qs,
        ...((v.assumptions as string[] | undefined) ?? []),
        v.countryCheck ? COUNTRY_CHECK_LINE : '',
        'Just reply and I’ll narrow it down.',
      ].filter(Boolean);
      const ra = vars.ra as Ra | null | undefined;
      if (!ra) return wrap(paras, paras.map(para));
      // After the note that we couldn't find it, before the questions.
      const at = v.eventNote ? 3 : 2;
      return wrap([...paras.slice(0, at), raText(ra), ...paras.slice(at)], [...paras.slice(0, at).map(para), raHtml(ra), ...paras.slice(at).map(para)]);
    }
    case 'browse_options': {
      // "What's on?" gets a few picks, each with why it fits and where to go next, then one easy next step.
      // Nothing is asked up front — quantity and budget only matter once the customer has picked something.
      const options = (v.options as string[]) ?? [];
      const picks = (vars.picks as Pick[] | undefined) ?? options.map((line) => ({ line, title: line, reason: '', eventUrl: null, links: [] }));
      const more = Number(v.moreCount ?? 0);
      const lead = [
        'Hey,',
        String(v.headline ?? ''),
        v.assumption ? String(v.assumption) : '',
      ].filter(Boolean);
      const tail = options.length
        ? [
            more > 0 ? `There ${more === 1 ? 'is 1 more' : `are ${more} more`} in that window. Reply "more" to see them, or tell me ${String(v.narrowBy ?? 'an artist, team or venue')} and I'll narrow it down.` : '',
            v.single
              ? 'Want me to check prices? Just tell me how many tickets.'
              : v.quantity ? `Reply with the one you want, and I’ll check prices for ${String(v.quantity)} tickets.` : 'Reply with the one you want and how many tickets, and I’ll check the prices.',
          ]
        : [String(v.emptyNote ?? ''), `Want me to look at different dates, or is there ${String(v.askFor ?? 'an artist or team')} you have in mind?`];
      const end = [...tail, v.countryCheck ? COUNTRY_CHECK_LINE : '', v.affiliate ? AFFILIATE_DISCLOSURE : ''].filter(Boolean);
      const ra = vars.ra as Ra | null | undefined;
      const text = [...lead, ...(picks.length ? [picks.map(pickText).join('\n\n')] : []), ...(ra ? [raText(ra)] : []), ...end];
      const html = [...lead.map(para), ...(picks.length ? [`<ul style="margin:0 0 18px;padding-left:20px;">${picks.map(pickHtml).join('')}</ul>`] : []), ...(ra ? [raHtml(ra)] : []), ...end.map(para)];
      return wrap(text, html);
    }
    case 'event_alert_set': {
      // The reply to "let me know when": what we'll watch for, in one sentence, and nothing else to do.
      const what = String(v.what ?? 'it');
      const lead = v.kind === 'on_sale'
        ? `${what} isn't on general sale yet.${v.saleOpens ? ` Ticketmaster lists the general sale opening ${String(v.saleOpens)}.` : ''} I'll email you the moment it opens, with the link.`
        : `Nothing's scheduled for ${what} yet. I'll email you as soon as a date is announced.`;
      const tail = ['Nothing else to do. Just keep an eye on this thread.', v.countryUnconfirmed ? COUNTRY_CHECK_LINE : ''].filter(Boolean);
      const text = ['Hey,', lead, ...tail];
      return wrap(text, text.map(para));
    }
    case 'event_alert': {
      // The alert itself: what happened, and the link. On sale: the one event. New date: up to three.
      const events = (v.events as unknown as Array<{ title: string; when: string; venue: string; url: string | null }>) ?? [];
      const seller = String(v.seller ?? 'Ticketmaster');
      const lead = v.kind === 'on_sale' ? `Good news: ${String(v.what)} is on general sale now on ${seller}.` : `${String(v.what)} just announced ${events.length === 1 ? 'a date' : 'dates'}${v.where ? ` in ${String(v.where)}` : ''}:`;
      const lines = events.map((e) => `${e.title}, ${e.when}, ${e.venue}${e.url ? `: ${e.url}` : ''}`);
      const tail = [
        v.kind === 'on_sale' ? '' : 'Want tickets for one of these? Reply with which one and how many.',
        v.affiliate ? AFFILIATE_DISCLOSURE : '',
      ].filter(Boolean);
      const text = ['Hey,', lead, ...lines, ...tail];
      const html = [
        para('Hey,'),
        para(lead),
        ...events.map((e) => `<p style="margin:0 0 12px;">${e.url ? link(e.title, e.url, true) : esc(e.title)}, ${esc(`${e.when}, ${e.venue}`)}</p>`),
        ...tail.map(para),
      ];
      return wrap(text, html);
    }
    case 'official_sale': {
      // One clear recommendation and a direct link to buy, written as a sentence. No prices: buy/wait is for
      // resale, and resale is one reply away.
      const notes = (v.notes as string[] | undefined) ?? [];
      const n = v.quantity ? Number(v.quantity) : null;
      const kind = v.sportsGame ? 'Games' : 'Events';
      const seller = String(v.seller);
      const title = String(v.eventTitle ?? v.eventLabel);
      const where = [v.eventWhen ? String(v.eventWhen) : '', v.venueName ? `at ${String(v.venueName)}` : ''].filter(Boolean).join(' ');
      const rest = ` is still on general sale on ${seller}, and that's where I'd buy${n ? ` your ${n} tickets` : ''}.`;
      const lead = `${title}${where ? ` (${where})` : ''}${rest}`;
      const tail = [
        ...notes,
        `${kind} that aren't sold out often go for less on resale. Want me to compare? Just reply "compare".`,
        v.countryUnconfirmed ? COUNTRY_CHECK_LINE : '',
        v.affiliate ? AFFILIATE_DISCLOSURE : '',
      ].filter(Boolean);
      const text = ['Hey,', lead, `Buy tickets on ${seller}: ${String(v.url)}`, ...tail];
      // The seller's name is the link to buy; the event title links to the event's page.
      const titleHtml = v.eventUrl ? link(title, String(v.eventUrl)) : esc(title);
      const leadHtml = `${titleHtml}${where ? ` (${esc(where)})` : ''}${esc(rest).replace(`on ${esc(seller)},`, `on ${link(seller, String(v.url), true)},`)}`;
      const html = [para('Hey,'), `<p style="margin:0 0 18px;">${leadHtml}</p>`, ...tail.map(para)];
      return wrap(text, html);
    }
    case 'holding': {
      // Sent when only a person can move the request; it promises a person, never a time or a result.
      const paras = [
        'Hey,',
        'Thanks for bearing with me. This one needs a person, so I’ve passed it to the team.',
        `You’ll hear back in this thread. The team replies from ${String(v.hours ?? '9am to 9pm ET')}.`,
      ];
      return wrap(paras, paras.map(para));
    }
    case 'unsupported':
      return wrap([String(v.reason ?? ''), `We're sorry we can't help with this one yet.`], [`<p>${esc(String(v.reason ?? ''))}</p>`, `<p>We're sorry we can't help with this one yet.</p>`]);
    case 'deletion_verification':
      return wrap([`We received a request to delete your Ticket Guy data. To confirm, reply to this email with the word CONFIRM. If you didn't ask for this, ignore this message.`], [`<p>We received a request to delete your Ticket Guy data. To confirm, reply to this email with the word <strong>CONFIRM</strong>. If you didn't ask for this, ignore this message.</p>`]);
    case 'watch_alert': {
      const total = Number(v.totalCents ?? 0);
      const dollars = `$${(total / 100).toFixed(total % 100 === 0 ? 0 : 2)}`;
      const line = `A verified option for ${String(v.quantity)} together${v.section ? ` in section ${String(v.section)}` : ''} is now ${dollars} total (checked ${String(v.observedAt)}).`;
      return wrap([line, `Link: ${String(v.url)}`, `Prices can change before checkout. Reply "stop" to end this watch.`], [`<p>${esc(line)}</p>`, `<p><a href="${esc(String(v.url))}">View this offer</a></p>`, `<p>Prices can change before checkout. Reply "stop" to end this watch.</p>`]);
    }
    case 'raw':
    case 'raw_auto':
      // The advice body gets the same signature and one disclosure as every other email. 'raw_auto' is the same
      // body sent without review (a price check, or any draft while testing), so it says so.
      return { text: [String(v.text), defaultSig.text, disclosure].join('\n\n'), html: `${BODY_OPEN}${String(v.html)}\n${defaultSig.html}${disclosureHtml(disclosure)}${BODY_CLOSE}` };
    default:
      throw new Error(`unknown template ${name}`);
  }
}
