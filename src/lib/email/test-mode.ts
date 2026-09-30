import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbOrTx } from '@/lib/db';
import * as t from '@/lib/db/schema';
import type { Env } from '@/lib/config/env';
import type { NormalizedAttachment, NormalizedInbound } from '@/lib/intake/contract';
import { buildReferencesChain, parseReferences } from '@/lib/intake/threading';
import { IMAGE_LIMITS } from '@/lib/media/image-validation';

/**
 * Test mode (DECISION_LOG #57). Everything runs as live — the model reads, research runs, drafts are written
 * and approved, the send gate is evaluated — and at the last step the email is recorded instead of handed to
 * Resend. Resend's daily quota counts received mail as well as sent, so test customers don't email in either:
 * their messages are injected here, threaded exactly as a mail client would thread a reply.
 *
 * Two rules decide whether a send is captured, both read at dispatch time:
 * - the `test_mode` switch is on (an admin toggles it on the Test mode page);
 * - the conversation holds a message a test customer wrote. Such a thread never emails anyone, whatever the
 *   switch says later, so turning test mode off can't send a real email to an invented address.
 */
export const TEST_MODE_KEY = 'test_mode';
/** `messages.provider` for everything test mode injects or captures. */
export const TEST_PROVIDER = 'test';
const TEST_DOMAIN = 'test-mode.invalid';

export function testModeFrom(switches: Record<string, boolean>): boolean {
  return switches[TEST_MODE_KEY] === true;
}

export async function testModeOn(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select({ enabled: t.killSwitches.enabled }).from(t.killSwitches).where(eq(t.killSwitches.key, TEST_MODE_KEY));
  return row?.enabled === true;
}

export async function isTestConversation(db: DbOrTx, conversationId: string | null): Promise<boolean> {
  if (!conversationId) return false;
  const [row] = await db
    .select({ id: t.messages.id })
    .from(t.messages)
    .where(and(eq(t.messages.conversationId, conversationId), eq(t.messages.direction, 'inbound'), eq(t.messages.provider, TEST_PROVIDER)))
    .limit(1);
  return !!row;
}

/** Of these conversations, the ones a test customer wrote in. Test requests are served, never counted as customers. */
export async function testConversationIds(db: DbOrTx, conversationIds: string[]): Promise<Set<string>> {
  if (!conversationIds.length) return new Set();
  const rows = await db
    .selectDistinct({ id: t.messages.conversationId })
    .from(t.messages)
    .where(and(inArray(t.messages.conversationId, conversationIds), eq(t.messages.direction, 'inbound'), eq(t.messages.provider, TEST_PROVIDER)));
  return new Set(rows.map((r) => r.id));
}

/** A recorded send's provider id; "sent" in the pilot's sense means really sent. */
export const isCapturedSendId = (providerMessageId: string | null | undefined): boolean => !!providerMessageId?.startsWith('test_');

/** A captured send's provider id and Message-ID. The Message-ID is what a test reply threads on. */
export function capturedIds(): { providerMessageId: string; rfcMessageId: string } {
  const id = randomUUID();
  return { providerMessageId: `test_${id}`, rfcMessageId: `<out-${id}@${TEST_DOMAIN}>` };
}

export type TestAttachment = { filename: string | null; contentType: string | null; bytes: Uint8Array<ArrayBuffer> };

export type TestInboundInput = {
  /** The test customer. Replying, it defaults to the thread's customer; another address starts a new thread, as it would by email. */
  from?: string | null;
  fromName?: string | null;
  subject?: string | null;
  text: string;
  /** Reply in this request's thread, to the latest email we sent in it. */
  replyToRequestId?: string | null;
  /** Quote our email under the reply the way Gmail does (default on), so quote stripping is exercised too. */
  quote?: boolean;
  attachments?: TestAttachment[];
};

export type TestInboundResult = { ok: true; message: NormalizedInbound } | { ok: false; error: 'test_mode_off' | 'request_not_found' | 'from_required' | 'too_many_attachments' | 'attachment_too_large' };

/** "Wed, Sep 30, 2026 at 3:53 PM", Gmail's attribution date. */
function gmailDate(at: Date, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year} at ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/**
 * The email a test customer would have sent, in the normalized inbound shape. A reply carries the
 * In-Reply-To and References a mail client would set for our latest email, so thread matching, participant
 * checks and quote stripping all run as they do for real mail. Refused while test mode is off.
 */
export async function buildTestInbound(db: DbOrTx, e: Env, input: TestInboundInput, now: Date): Promise<TestInboundResult> {
  if (!(await testModeOn(db))) return { ok: false, error: 'test_mode_off' };
  const files = input.attachments ?? [];
  if (files.length > IMAGE_LIMITS.maxImagesPerMessage) return { ok: false, error: 'too_many_attachments' };
  if (files.some((f) => f.bytes.byteLength > IMAGE_LIMITS.maxBytes)) return { ok: false, error: 'attachment_too_large' };

  let from = input.from?.trim() || null;
  let subject = input.subject?.trim() || null;
  let text = input.text;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  if (input.replyToRequestId) {
    const [req] = await db.select({ conversationId: t.requests.conversationId, contactId: t.requests.contactId }).from(t.requests).where(eq(t.requests.id, input.replyToRequestId));
    if (!req) return { ok: false, error: 'request_not_found' };
    const [contact] = await db.select({ email: t.contacts.emailOriginal }).from(t.contacts).where(eq(t.contacts.id, req.contactId));
    from ??= contact?.email ?? null;
    const thread = await db.select().from(t.messages).where(eq(t.messages.conversationId, req.conversationId)).orderBy(desc(t.messages.receivedAt));
    // The customer replies to our latest email; before we have sent one, to their own last message.
    const parent = thread.find((m) => m.direction === 'outbound') ?? thread[0] ?? null;
    const anchor = parent?.rfcMessageId ?? thread.find((m) => m.rfcMessageId)?.rfcMessageId ?? null;
    if (anchor) {
      inReplyTo = anchor;
      references = buildReferencesChain(parseReferences(parent?.inReplyTo ?? null, parent?.referencesHeader ?? null), anchor);
    }
    const parentSubject = parent?.subject ?? thread.find((m) => m.subject)?.subject ?? null;
    subject ??= parentSubject ? (/^re:/i.test(parentSubject) ? parentSubject : `Re: ${parentSubject}`) : null;
    if (input.quote !== false && parent?.direction === 'outbound' && parent.sanitizedText) {
      const who = parent.fromAddress.includes('<') ? parent.fromAddress : `Ticket Guy <${parent.fromAddress}>`;
      const quoted = parent.sanitizedText.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
      text = `${text.trimEnd()}\n\nOn ${gmailDate(parent.receivedAt, e.STAFFED_HOURS_TIMEZONE)} ${who} wrote:\n\n${quoted}`;
    }
  }
  if (!from) return { ok: false, error: 'from_required' };

  const id = randomUUID();
  const attachments: NormalizedAttachment[] = files.map((f, i) => ({ providerAttachmentId: `test-att-${id}-${i}`, filename: f.filename, declaredMimeType: f.contentType, bytes: f.bytes, inline: false }));
  return {
    ok: true,
    message: {
      provider: TEST_PROVIDER,
      providerEmailId: `test-${id}`,
      rfcMessageId: `<in-${id}@${TEST_DOMAIN}>`,
      inReplyTo,
      references,
      from,
      fromName: input.fromName?.trim() || null,
      to: [e.CONCIERGE_INBOUND_ADDRESS],
      subject,
      text,
      headers: {},
      receivedAt: now,
      attachments,
      authentication: { spf: null, dkim: null, dmarc: null },
      signatureVerified: false,
    },
  };
}

/** Recent conversations a test customer wrote in, newest first, with their latest request. */
export async function recentTestRequests(db: DbOrTx, limit = 30): Promise<Array<{ requestId: string; state: string; from: string; subject: string | null; at: Date }>> {
  const rows = await db
    .select({ conversationId: t.messages.conversationId, from: t.messages.fromAddress, subject: t.messages.subject, at: t.messages.receivedAt })
    .from(t.messages)
    .where(and(eq(t.messages.direction, 'inbound'), eq(t.messages.provider, TEST_PROVIDER)))
    .orderBy(desc(t.messages.receivedAt))
    .limit(limit * 4);
  const seen = new Set<string>();
  const out: Array<{ requestId: string; state: string; from: string; subject: string | null; at: Date }> = [];
  for (const r of rows) {
    if (seen.has(r.conversationId) || out.length >= limit) continue;
    seen.add(r.conversationId);
    const [req] = await db.select({ id: t.requests.id, state: t.requests.state }).from(t.requests).where(eq(t.requests.conversationId, r.conversationId)).orderBy(desc(t.requests.createdAt)).limit(1);
    if (req) out.push({ requestId: req.id, state: req.state, from: r.from, subject: r.subject, at: r.at });
  }
  return out;
}
