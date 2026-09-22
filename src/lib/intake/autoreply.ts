/**
 * Detects mail that must never receive a concierge auto-response (A21): DSNs, list/bulk mail,
 * Auto-Submitted, out-of-office, and the service's own addresses.
 */
export type InboundHeaders = Record<string, string | undefined>;

export type AutoReplyVerdict = { autoResponse: boolean; reasons: string[] };

const OOO_SUBJECT = /\b(out of (the )?office|auto(matic)?[- ]?reply|automatic response|away from (my )?(e-?mail|desk)|vacation|delivery (status|failure) notification|undeliverable|mail delivery failed|returned mail)\b/i;

export function detectAutoResponse(args: { headers: InboundHeaders; subject: string | null; from: string; serviceAddresses: string[] }): AutoReplyVerdict {
  const reasons: string[] = [];
  const h = Object.fromEntries(Object.entries(args.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const autoSubmitted = h['auto-submitted'];
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') reasons.push('auto_submitted');
  if (h['x-auto-response-suppress']) reasons.push('x_auto_response_suppress');
  if (h['x-autoreply'] || h['x-autorespond']) reasons.push('x_autoreply');
  const precedence = h['precedence']?.toLowerCase();
  if (precedence && ['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) reasons.push(`precedence_${precedence}`);
  if (h['list-id'] || h['list-unsubscribe'] || h['list-post']) reasons.push('list_mail');
  const ct = h['content-type']?.toLowerCase() ?? '';
  if (ct.includes('multipart/report') || ct.includes('delivery-status')) reasons.push('delivery_status_notification');
  const from = args.from.toLowerCase();
  const local = from.split('@')[0] ?? '';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce|bounces|notifications?)(\+|@|$|-)/.test(local) || local.startsWith('mailer-daemon')) reasons.push('system_sender');
  if (args.serviceAddresses.map((a) => a.toLowerCase()).includes(from)) reasons.push('own_address');
  if (args.subject && OOO_SUBJECT.test(args.subject)) reasons.push('subject_pattern');
  if (h['return-path'] === '<>' || h['return-path'] === '') reasons.push('null_return_path');
  return { autoResponse: reasons.length > 0, reasons };
}
