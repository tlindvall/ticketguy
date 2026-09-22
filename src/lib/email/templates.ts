/**
 * Bounded email templates (API_AND_DATA_CONTRACTS §6). Text + HTML, escaped user text, no invented availability.
 * Recommendation bodies come pre-rendered from the advice renderer ('raw').
 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FOOTER_TEXT = 'Ticket Guy is AI-assisted and human-reviewed. We compare options and link you to the seller; we never buy, hold or resell tickets. Reply to this email any time.';

export function renderTemplate(name: string, vars: Record<string, unknown>, _ctx: { appUrl: string; postalAddress: string | null }): { text: string; html: string } {
  const v = vars as Record<string, string | string[] | boolean | number | null | undefined>;
  const wrap = (paras: string[], htmlParas: string[]) => ({
    text: [...paras, '', '— Ticket Guy', FOOTER_TEXT].join('\n\n'),
    html: `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.5;color:#111;max-width:640px;margin:0 auto;padding:16px">${htmlParas.join('\n')}<p>— Ticket Guy</p><p style="color:#555;font-size:13px">${esc(FOOTER_TEXT)}</p></body></html>`,
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
      const known = (v.knownFacts as string[]) ?? [];
      const qs = (v.questions as string[]) ?? [];
      const paras = [v.eventNote ? String(v.eventNote) : `Thanks — a couple of details before we check prices.`, known.length ? `What we have so far:\n${list(known)}` : '', qs.length ? `Could you tell us:\n${qs.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : '', `Just reply in this thread.`].filter(Boolean);
      const html = [`<p>${esc(v.eventNote ? String(v.eventNote) : 'Thanks — a couple of details before we check prices.')}</p>`, known.length ? `<p>What we have so far:</p>${htmlList(known)}` : '', qs.length ? `<p>Could you tell us:</p><ol>${qs.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>` : '', `<p>Just reply in this thread.</p>`].filter(Boolean);
      return wrap(paras, html);
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
      return { text: `${String(v.text)}\n\n${FOOTER_TEXT}`, html: `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.5;color:#111;max-width:640px;margin:0 auto;padding:16px">${String(v.html)}<p style="color:#555;font-size:13px">${esc(FOOTER_TEXT)}</p></body></html>` };
    default:
      throw new Error(`unknown template ${name}`);
  }
}
