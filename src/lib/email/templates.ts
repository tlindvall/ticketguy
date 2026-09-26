import { isSlotName, renderAuthored, type SlotName, type TemplateOverrides, type TemplateValue } from './custom-templates';
import { renderSignature, type SignatureKind } from './signature';

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

/** The eligibility question, asked once, on its own line rather than as one of the request questions. */
export const COUNTRY_CHECK_LINE = 'One more thing, since we can only help US-based customers for now: are you based in the US?';

/** Maps the pipeline's variables onto the names staff author against. */
function authoringVars(slot: SlotName, v: Record<string, TemplateValue>): Record<string, TemplateValue> {
  if (slot !== 'watch_alert') return v;
  const total = Number(v.totalCents ?? 0);
  return { ...v, priceTotal: `$${(total / 100).toFixed(total % 100 === 0 ? 0 : 2)}` };
}

export function renderTemplate(
  name: string,
  vars: Record<string, unknown>,
  ctx: { appUrl: string; postalAddress: string | null; overrides?: TemplateOverrides; signature?: SignatureKind },
): { text: string; html: string } {
  const v = vars as Record<string, string | string[] | boolean | number | null | undefined>;
  const slot: SlotName | null = isSlotName(name) ? name : null;
  const override = slot ? ctx.overrides?.[slot] : undefined;
  const disclosure = disclosureFor(name);
  const defaultSig = renderSignature(ctx.signature ?? 'short', ctx.appUrl);
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
  const htmlList = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  switch (name) {
    case 'acknowledgment': {
      const known = (v.knownFacts as string[]) ?? [];
      const paras = [`Got it — we're checking options for ${String(v.eventLabel ?? 'your request')}.`, known.length ? `What we understood:\n${list(known)}` : '', v.countryUnconfirmed ? `One quick check: we serve US customers only — reply if you're not in the US.` : '', `We'll reply in this thread once a person has reviewed the comparison. No purchases happen on our side.`].filter(Boolean);
      const html = [`<p>Got it — we're checking options for ${esc(String(v.eventLabel ?? 'your request'))}.</p>`, known.length ? `<p>What we understood:</p>${htmlList(known)}` : '', v.countryUnconfirmed ? `<p>One quick check: we serve US customers only — reply if you're not in the US.</p>` : '', `<p>We'll reply in this thread once a person has reviewed the comparison. No purchases happen on our side.</p>`].filter(Boolean);
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
        v.countryCheck ? COUNTRY_CHECK_LINE : '',
        'Just reply and I’ll narrow it down.',
      ].filter(Boolean);
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
      // The advice renderer signs its own body, so no second signature here.
      return { text: `${String(v.text)}\n\n${disclosure}`, html: `${BODY_OPEN}${String(v.html)}${disclosureHtml(disclosure)}${BODY_CLOSE}` };
    default:
      throw new Error(`unknown template ${name}`);
  }
}
