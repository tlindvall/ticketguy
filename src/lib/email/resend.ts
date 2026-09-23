import { Resend } from 'resend';
import type { EmailProvider } from '@/lib/intake/pipeline';
import type { NormalizedInbound, NormalizedAttachment } from '@/lib/intake/contract';
import { validateUrlSyntax, validateUrlDestination } from '@/lib/security/url-safety';
import { IMAGE_LIMITS } from '@/lib/media/image-validation';

/**
 * Resend adapters. Outbound: idempotency key = send-intent dedupe key, byte-identical payload on retry.
 * Inbound: the webhook carries metadata only; full content and attachment URLs are retrieved through the
 * authenticated API, then downloaded with a bounded, URL-validated fetcher (never credential-forwarding).
 * Field names follow the Resend receiving docs at research time; validate against the live payload in staging.
 */
export class ResendProvider implements EmailProvider {
  private readonly client: Resend;
  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }
  async send(args: { idempotencyKey: string; from: string; to: string; subject: string; text: string; html: string; headers: Record<string, string> }): Promise<{ providerMessageId: string }> {
    const { data, error } = await this.client.emails.send({ from: args.from, to: [args.to], subject: args.subject, text: args.text, html: args.html, headers: args.headers }, { idempotencyKey: args.idempotencyKey });
    if (error || !data) throw new Error(`resend_send_failed: ${error?.name ?? 'unknown'}: ${error?.message ?? ''}`);
    return { providerMessageId: data.id };
  }
}

export type ResendReceivedWebhook = { type: string; created_at?: string; data: { email_id?: string; id?: string; from?: string; to?: string[]; subject?: string; message_id?: string; created_at?: string; [k: string]: unknown } };

export type ReceivedEmailDetail = {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  created_at: string;
  attachments: Array<{ id: string; filename: string | null; content_type: string | null; size: number | null; download_url: string | null }>;
  spf?: string | null;
  dkim?: string | null;
  dmarc?: string | null;
};

/**
 * Reads the provider's error envelope so a failure names its cause. Only the envelope's own `name` and
 * `message` are surfaced, bounded — never the email body, headers or any credential. A bare status code
 * cannot distinguish a restricted key from a wrong id, which cost a day of guessing once.
 */
async function providerErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { name?: unknown; error?: unknown; message?: unknown };
    const name = typeof body.name === 'string' ? body.name : typeof body.error === 'string' ? body.error : null;
    const message = typeof body.message === 'string' ? body.message : null;
    const parts = [name, message].filter((p): p is string => Boolean(p));
    return parts.length ? `:${parts.join(': ').slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

/** Fetches a received email by id. Uses the SDK when it exposes the call, else the REST endpoint. */
export async function fetchReceivedEmail(apiKey: string, emailId: string, fetchImpl: typeof fetch = fetch): Promise<ReceivedEmailDetail> {
  const res = await fetchImpl(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`resend_receive_fetch_failed:${res.status}${await providerErrorDetail(res)}`);
  const j = (await res.json()) as Record<string, unknown>;
  const hdrs = (j.headers ?? {}) as Record<string, string> | Array<{ name: string; value: string }>;
  const headers: Record<string, string> = Array.isArray(hdrs) ? Object.fromEntries(hdrs.map((h) => [h.name, h.value])) : hdrs;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    id: String(j.id ?? emailId),
    from: String(j.from ?? ''),
    to: (j.to as string[]) ?? [],
    subject: (j.subject as string) ?? null,
    text: (j.text as string) ?? null,
    html: (j.html as string) ?? null,
    headers,
    message_id: (j.message_id as string) ?? lower['message-id'] ?? null,
    in_reply_to: lower['in-reply-to'] ?? null,
    references: lower['references'] ?? null,
    created_at: String(j.created_at ?? new Date().toISOString()),
    attachments: ((j.attachments as Array<Record<string, unknown>>) ?? []).map((a) => ({ id: String(a.id ?? ''), filename: (a.filename as string) ?? null, content_type: (a.content_type as string) ?? null, size: (a.size as number) ?? null, download_url: (a.download_url as string) ?? null })),
    spf: (j.spf as string) ?? null,
    dkim: (j.dkim as string) ?? null,
    dmarc: (j.dmarc as string) ?? null,
  };
}

const ATTACHMENT_HOSTS = ['resend.com', 'resend-attachments.com', 'amazonaws.com'];

/** Downloads attachment bytes from provider-supplied URLs only, bounded in size and host. */
export async function downloadAttachments(detail: ReceivedEmailDetail, fetchImpl: typeof fetch = fetch): Promise<{ attachments: NormalizedAttachment[]; skipped: Array<{ id: string; reason: string }> }> {
  const out: NormalizedAttachment[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const a of detail.attachments) {
    if (!a.download_url) {
      skipped.push({ id: a.id, reason: 'no_download_url' });
      continue;
    }
    if (a.size !== null && a.size > IMAGE_LIMITS.maxBytes) {
      skipped.push({ id: a.id, reason: 'too_large' });
      continue;
    }
    const syn = validateUrlSyntax(a.download_url, { allowedHosts: ATTACHMENT_HOSTS });
    if (!syn.ok) {
      skipped.push({ id: a.id, reason: `url_${syn.reason}` });
      continue;
    }
    const dest = await validateUrlDestination(syn.url);
    if (!dest.ok) {
      skipped.push({ id: a.id, reason: `url_${dest.reason}` });
      continue;
    }
    const res = await fetchImpl(syn.url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      skipped.push({ id: a.id, reason: `http_${res.status}` });
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > IMAGE_LIMITS.maxBytes) {
      skipped.push({ id: a.id, reason: 'too_large' });
      continue;
    }
    out.push({ providerAttachmentId: a.id, filename: a.filename, declaredMimeType: a.content_type, bytes: buf, inline: false });
  }
  return { attachments: out, skipped };
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractAddress(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1]! : s).trim();
}

export function normalizeReceived(detail: ReceivedEmailDetail, attachments: NormalizedAttachment[], signatureVerified: boolean): NormalizedInbound {
  return {
    provider: 'resend',
    providerEmailId: detail.id,
    rfcMessageId: detail.message_id,
    inReplyTo: detail.in_reply_to,
    references: detail.references,
    from: extractAddress(detail.from),
    to: detail.to.map(extractAddress),
    subject: detail.subject,
    text: detail.text ?? (detail.html ? stripHtml(detail.html) : ''),
    headers: detail.headers,
    receivedAt: new Date(detail.created_at),
    attachments,
    authentication: { spf: detail.spf ?? null, dkim: detail.dkim ?? null, dmarc: detail.dmarc ?? null },
    signatureVerified,
  };
}
