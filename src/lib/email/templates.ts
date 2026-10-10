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
// The brief's "we are not a marketplace" is said on every reply, not only the reviewed ones: while drafts auto-approve,
// no live customer saw it (audit 2026-10-10, critic: the scope line lived only in the reviewed footers).
const AUTOMATED_FOOTER = 'AI-assisted ticket advice. We never buy, hold or resell tickets.';
/** Templates that are only ever sent after a person approved that exact message. */
const REVIEWED_TEMPLATES: ReadonlySet<string> = new Set(['raw', 'watch_alert', 'watch_alert_market']);
// A market heads-up has no link by design, so its footer doesn't promise one (PW QA wave 1).
const MARKET_ALERT_FOOTER = 'Ticket Guy is AI-assisted and human-reviewed. We never buy, hold or resell tickets. Reply to this email any time.';
const disclosureFor = (name: string) => (name === 'watch_alert_market' ? MARKET_ALERT_FOOTER : REVIEWED_TEMPLATES.has(name) ? REVIEWED_FOOTER : AUTOMATED_FOOTER);

// One type size for everything a person reads, 16/24, in Ticket Guy ink; 640px wide at most with 20px either side, so
// nothing scrolls sideways at 320px (personal-email design, Oct 3).
const BODY_OPEN = '<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;"><div style="max-width:640px;padding:0 20px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#142438;">';
const BODY_CLOSE = '</div></body></html>';
const disclosureHtml = (text: string) => `<p style="margin:16px 0 0;font-size:14px;line-height:21px;color:#536174;">${esc(text)}</p>`;
const para = (text: string) => `<p style="margin:0 0 18px;">${esc(text)}</p>`;
/** A paragraph whose lines after the first start with "• " is a lead line and a list (the shows elsewhere, live Oct 3). */
const block = (text: string) => {
  const [head, ...rest] = text.split('\n');
  if (!rest.length || !rest.every((l) => l.startsWith('• '))) return para(text);
  return `<p style="margin:0 0 8px;">${esc(head!)}</p><ul style="margin:0 0 18px;padding-left:20px;">${rest.map((l) => `<li style="margin:0 0 4px;">${esc(l.slice(2))}</li>`).join('')}</ul>`;
};

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
  // The date and start time are what a schedule question turns on, so they carry the emphasis (TGQA-R8 writing review 3).
  return `<li style="margin:0 0 10px;"><strong>${esc(when ?? '')}</strong>: ${titled}.${p.reason ? ` ${esc(p.reason)}` : ''}${links ? ` ${links}` : ''}</li>`;
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
      // A later message while the answer is still being worked on (a draft waiting for review, re-researched): one
      // line saying what changed and that the updated answer is coming, so they aren't left in silence (audit gap 3).
      if (v.update) {
        const paras = ['Hey,', String(v.update)];
        return wrap(paras, paras.map(para));
      }
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
      // The note is paragraphs of its own (what I searched, then the nearest games as a list): one block each, or a
      // list run into the sentence before it (live Oct 5: "The closest games I have: • Tomorrow… • Sunday…" in one line).
      const note = v.eventNote ? String(v.eventNote).split(/\n{2,}/).filter(Boolean) : [];
      const paras = [
        'Hey,',
        v.acknowledgement ? String(v.acknowledgement) : 'Thanks for getting in touch.',
        ...note,
        ...qs,
        ...((v.assumptions as string[] | undefined) ?? []),
        v.countryCheck ? COUNTRY_CHECK_LINE : '',
        // No stock closer: the questions are the next step (TGQA-R6 writing review).
      ].filter(Boolean);
      const ra = vars.ra as Ra | null | undefined;
      if (!ra) return wrap(paras, paras.map(block));
      // After the note that we couldn't find it, before the questions.
      const at = 2 + note.length;
      return wrap([...paras.slice(0, at), raText(ra), ...paras.slice(at)], [...paras.slice(0, at).map(block), raHtml(ra), ...paras.slice(at).map(block)]);
    }
    case 'browse_options': {
      // "What's on?" gets a few picks, each with why it fits and where to go next, then one easy next step.
      // Nothing is asked up front — quantity and budget only matter once the customer has picked something.
      const options = (v.options as string[]) ?? [];
      const picks = (vars.picks as Pick[] | undefined) ?? options.map((line) => ({ line, title: line, reason: '', eventUrl: null, links: [] }));
      const more = Number(v.moreCount ?? 0);
      // The answer to what they asked comes first, in bold; a correction is acknowledged once, right after it.
      const answer = v.answer ? String(v.answer) : '';
      const corrections = ((vars.corrections as string[] | undefined) ?? []).join(' ');
      const lead = [
        'Hey,',
        String(v.headline ?? ''),
        v.assumption ? String(v.assumption) : '',
      ].filter(Boolean);
      const top = [answer, corrections].filter(Boolean);
      const tail = options.length
        ? [
            more > 0 ? `There ${more === 1 ? 'is 1 more' : `are ${more} more`} in that window. Reply "more" to see them, or tell me ${String(v.narrowBy ?? 'an artist, team or venue')} and I'll narrow it down.` : '',
            v.pickNext
              ? String(v.pickNext)
              : v.single
              ? 'Want me to check prices? Just tell me how many tickets.'
              : v.quantity ? `Reply with the one you want, and I’ll check prices for ${String(v.quantity)} tickets.` : 'Reply with the one you want and how many tickets, and I’ll check the prices.',
          ]
        : [String(v.emptyNote ?? ''), v.nextStep ? String(v.nextStep) : `Want me to look at different dates, or is there ${String(v.askFor ?? 'an artist or team')} you have in mind?`];
      const end = [...tail, v.countryCheck ? COUNTRY_CHECK_LINE : '', v.affiliate ? AFFILIATE_DISCLOSURE : ''].filter(Boolean);
      const ra = vars.ra as Ra | null | undefined;
      const text = [lead[0]!, ...top, ...lead.slice(1), ...(picks.length ? [picks.map(pickText).join('\n\n')] : []), ...(ra ? [raText(ra)] : []), ...end];
      const html = [para(lead[0]!), ...(answer ? [`<p style="margin:0 0 18px;"><strong>${esc(answer)}</strong>${corrections ? ` ${esc(corrections)}` : ''}</p>`] : corrections ? [para(corrections)] : []), ...lead.slice(1).map(para), ...(picks.length ? [`<ul style="margin:0 0 18px;padding-left:20px;">${picks.map(pickHtml).join('')}</ul>`] : []), ...(ra ? [raHtml(ra)] : []), ...end.map(para)];
      return wrap(text, html);
    }
    case 'games_ranked': {
      // "Which game is cheapest?" answered as a verdict, the games ranked under it, then one next action (live Oct 9: the
      // comparison was an acknowledgement line, and a single game's trend brief followed). Same list mechanics as the
      // browse picks, so the plain text and the HTML stay in step.
      const picks = (vars.picks as Pick[] | undefined) ?? [];
      const end = [v.unpriced ? String(v.unpriced) : '', String(v.nextStep ?? ''), v.countryCheck ? COUNTRY_CHECK_LINE : '', v.affiliate ? AFFILIATE_DISCLOSURE : ''].filter(Boolean);
      const headline = String(v.headline ?? '');
      const text = ['Hey,', headline, ...(picks.length ? [picks.map(pickText).join('\n\n')] : []), ...end];
      const html = [para('Hey,'), `<p style="margin:0 0 18px;"><strong>${esc(headline)}</strong></p>`, ...(picks.length ? [`<ul style="margin:0 0 18px;padding-left:20px;">${picks.map(pickHtml).join('')}</ul>`] : []), ...end.map(para)];
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
      // No prices: buy/wait is for resale, and resale is one reply away. "That's where I'd buy" only when they
      // asked for nothing the sale being open can't vouch for; with a budget, seats together or access needs, the
      // event page is offered neutrally with what to check on it (TG-B01).
      const notes = (v.notes as string[] | undefined) ?? [];
      const unverified = ((v.unverified as string[] | undefined) ?? []).filter(Boolean);
      const n = v.quantity ? Number(v.quantity) : null;
      const kind = v.sportsGame ? 'Games' : 'Events';
      const seller = String(v.seller);
      const title = String(v.eventTitle ?? v.eventLabel);
      const where = [v.eventWhen ? String(v.eventWhen) : '', v.venueName ? `at ${String(v.venueName)}` : ''].filter(Boolean).join(' ');
      // A browse that found one show opens with what it is and what's still unchecked (writing review, G02).
      const opening = v.opening ? String(v.opening) : '';
      const rest = unverified.length
        ? ` is on general sale on ${seller}. I haven’t seen its seats or prices${opening ? '.' : ', so I can’t tell you yet whether any fit what you need.'}`
        // An open sale is the sale window, not stock: the page can say sold out while the catalog says on sale (live Oct 2).
        : ` is still on general sale on ${seller}. I can’t see whether it has seats left, but if it does, that's where I'd buy${n ? ` your ${n} tickets` : ''}.`;
      // Asked again whether we've checked: the answer is no, first, in plain words.
      const recheckLine = v.recheck && unverified.length ? `No, I haven't checked any of these: I can't see ${seller}'s seats, their prices or their access from here.` : '';
      const lead = `${title}${where ? ` (${where})` : ''}${rest}`;
      const checkLead = `Check these on the event page before you buy${n && n !== 2 ? ` (set the number of tickets to ${n} first; the page may start at 2)` : ''}:`;
      const tail = [
        // The seller's page opens at its own default quantity, which is not always theirs.
        ...(!unverified.length && n && n !== 2 ? [`The page may start at 2 tickets, so set it to ${n}.`] : []),
        ...notes,
        // The invitation says what a comparison can and can't do (retest R2-B03): resale price levels for the
        // group, not a check of particular seats, their access or whether they sit together.
        unverified.length
          ? `If you'd like to see where resale prices start for ${n ? `${n} tickets` : 'your group'}, reply "compare". That shows price levels only: I can't check particular seats, their access or whether they sit together for you.`
          : `${kind} that aren't sold out often go for less on resale. Want me to compare? Just reply "compare".`,
        v.countryUnconfirmed ? COUNTRY_CHECK_LINE : '',
        v.affiliate ? AFFILIATE_DISCLOSURE : '',
      ].filter(Boolean);
      // No offer has been checked here, so the link is the event page, whatever is on sale (launch A22).
      const linkLine = `Event page on ${seller}: ${String(v.url)}`;
      const text = ['Hey,', ...(recheckLine ? [recheckLine] : []), ...(opening ? [opening] : []), lead, ...(unverified.length ? [checkLead, unverified.map((u) => `- ${u}`).join('\n')] : []), linkLine, ...tail];
      // The seller's name is the link; the event title links to the event's page.
      const titleHtml = v.eventUrl ? link(title, String(v.eventUrl)) : esc(title);
      const leadHtml = `${titleHtml}${where ? ` (${esc(where)})` : ''}${esc(rest).replace(`on ${esc(seller)}`, `on ${link(seller, String(v.url), true)}`)}`;
      const checks = unverified.length ? [`<p style="margin:0 0 8px;font-weight:600;">${esc(checkLead)}</p>`, `<ul style="margin:0 0 18px;padding-left:22px;">${unverified.map((u) => `<li style="margin:0 0 8px;">${esc(u)}</li>`).join('')}</ul>`] : [];
      const html = [para('Hey,'), ...(recheckLine ? [para(recheckLine)] : []), ...(opening ? [`<p style="margin:0 0 18px;"><strong>${esc(opening.split(/(?<=\.)\s/)[0]!)}</strong>${esc(opening.slice(opening.split(/(?<=\.)\s/)[0]!.length))}</p>`] : []), `<p style="margin:0 0 18px;">${leadHtml}</p>`, ...checks, ...tail.map(para)];
      return wrap(text, html);
    }
    case 'holding': {
      // Sent when only a person can move the request. It says what happened and where the answer will come, and
      // promises no time and no result: office hours are not a response time (post-#56 writing review).
      // A follow-up parked behind it is told the same person has both, so it never goes unanswered (R1-HUMAN-03).
      // When people check is said as that, not as a promised reply time (Final Human QA R1-HUMAN-01).
      const hours = v.hours ? ` The team checks these ${String(v.hours)}.` : '';
      const paras = v.followUp
        ? ['Hey,', `Got your follow-up. It’s with the same person who has your first email, and they’ll answer both here in this thread.${hours}`]
        : ['Hey,', `I couldn’t finish this one automatically, so it needs a manual check. I’ve passed it to the team, and the answer will come in this thread.${hours}`];
      return wrap(paras, paras.map(para));
    }
    case 'follow_up': {
      // One question, once, the day after the event: the pilot's measure of whether we helped. No links, no pitch.
      const paras = [
        'Hey,',
        `How did ${String(v.what ?? 'it')} go?`,
        'One quick question, because it helps me get better: did my note change which tickets you bought, or when you bought them? A one-line reply is plenty, and "no" is a useful answer too.',
      ];
      return wrap(paras, paras.map(para));
    }
    case 'outcome_ack': {
      const kind = String(v.kind ?? '');
      const paras = [
        'Hey,',
        // Only what was running is said to have stopped: no watch, no "stopped keeping an eye" (TGQA-R6 1015).
        kind === 'bought'
          ? v.watched ? 'Glad you got them. I’ve stopped the price watch on this one. Enjoy it.' : 'Glad you got them. Enjoy it.'
          : kind === 'stopped'
            ? v.watched ? 'Done: I’ve stopped keeping an eye on this one. Just reply if you want me to look again.' : 'Done. There was nothing running on this one, so nothing else will come from it. Just reply if you want me to look again.'
            : 'Thanks, that really helps.',
      ];
      return wrap(paras, paras.map(para));
    }
    case 'off_topic': {
      // A first message with nothing about tickets in it (a general question, a test, a jibe): say what we do,
      // once, without assuming a request. It never engages with the content.
      const paras = [
        'Hey,',
        'I only do tickets: sports, concerts and shows in the US. I’ll leave that one to someone else.',
        'If you’re after tickets, tell me what you want to see, roughly when, and how many. A link or a screenshot works too.',
      ];
      return wrap(paras, paras.map(para));
    }
    case 'unsupported': {
      // A person saying no: greeted, in the first person, the event named when we know it, and the one thing they
      // can do, which is put us right if we misread them (audit gap 37: no greeting, "We're sorry we can't help").
      const paras = [
        'Hey,',
        String(v.reason ?? ''),
        `I’m sorry I can’t help with ${v.what ? String(v.what) : 'this one'} yet. If I’ve got that wrong, just reply and tell me.`,
      ].filter(Boolean);
      return wrap(paras, paras.map(para));
    }
    case 'deletion_verification':
      return wrap([`We received a request to delete your Ticket Guy data. To confirm, reply to this email with the word CONFIRM. If you didn't ask for this, ignore this message.`], [`<p>We received a request to delete your Ticket Guy data. To confirm, reply to this email with the word <strong>CONFIRM</strong>. If you didn't ask for this, ignore this message.</p>`]);
    case 'watch_alert': {
      const total = Number(v.totalCents ?? 0);
      const dollars = `$${(total / 100).toFixed(total % 100 === 0 ? 0 : 2)}`;
      // First person with the event named, every fact kept: the party together, the section, the verified total, when
      // it was checked, the link, the caveat and how to stop (audit gap 37: no greeting, no event, "Link:").
      const what = v.eventLabel ? String(v.eventLabel) : 'the event you asked me to watch';
      const line = `I’ve found a verified option for ${what}: ${String(v.quantity)} together${v.section ? ` in section ${String(v.section)}` : ''}, now ${dollars} total (checked ${String(v.observedAt)}).`;
      const next = 'If you want them, here’s the listing:';
      const tail = 'Prices can change before checkout, so check the total before you pay. Reply "stop" to end this watch.';
      return wrap(['Hey,', line, `${next} ${String(v.url)}`, tail], [para('Hey,'), para(line), `<p style="margin:0 0 18px;">${esc(next)} ${link('View this offer', String(v.url), true)}</p>`, para(tail)]);
    }
    case 'watch_alert_market': {
      // A heads-up from resale market data (DECISION_LOG #62): listed prices before fees, the fee allowance said as
      // an assumption, and what the data can't show said once. Never "found", never a link we didn't check.
      const usd = (c: unknown) => { const n = Number(c ?? 0); return `$${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}`; };
      const q = Number(v.quantity ?? 0);
      const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
      const n = words[q] ?? String(q);
      const listings = Number(v.listings ?? 0);
      // The decision number leads and is the only bold: the estimate for the party against their budget.
      const total = `about ${usd(v.estimatedTotalCents)} for ${n}`;
      const lead = `Heads-up: resale listings now come to ${total} with fees, inside your ${usd(v.targetTotalCents)}.`;
      const fit = `That’s for ${String(v.eventLabel)}: listings with ${q} or more tickets start at ${usd(v.listedPerTicketCents)} a ticket before fees, ${usd(v.listedTotalCents)} for ${n}${listings > 1 ? ` (${listings} listings could seat ${n})` : ''}, plus an assumed ${String(v.feeAllowancePct)}% for fees. Checkout fees can be higher.`;
      const limits = `This is from resale market data (StubHub and Vivid Seats listings, seen ${String(v.observedAt)}), not a ticket I’ve checked: I don’t have a link to it, it may be gone when you look, and a listing of ${q} or more may not sell exactly ${n} or be seats together. If you want it, look it up on StubHub and Vivid Seats now and check the all-in price at checkout.`;
      const stop = 'Reply “stop” to end this watch.';
      const i = lead.indexOf(total);
      return wrap([lead, fit, limits, stop], [`<p style="margin:0 0 18px;">${esc(lead.slice(0, i))}<strong>${esc(total)}</strong>${esc(lead.slice(i + total.length))}</p>`, para(fit), para(limits), para(stop)]);
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
