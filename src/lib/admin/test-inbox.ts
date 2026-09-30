import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { getConcierge } from '@/lib/services';
import { inngest, outboxKick } from '@/inngest/client';
import { runOutboxBatch } from '@/inngest/functions';
import { buildTestInbound, isTestConversation, TEST_PROVIDER } from '@/lib/email/test-mode';
import { reasonText, sendClassLabel, stateInfo } from '@/lib/admin/labels';
import { audit } from '@/lib/util/audit';
import type { IngestOutcome } from '@/lib/intake/pipeline';

/** What the admin form and the agent API both accept. Attachments arrive base64-encoded (images, as a customer would attach). */
export const TestMessageBody = z.object({
  from: z.string().trim().email().nullish(),
  name: z.string().trim().max(100).nullish(),
  subject: z.string().max(200).nullish(),
  text: z.string().min(1).max(20_000),
  replyToRequestId: z.string().uuid().nullish(),
  quote: z.boolean().default(true),
  attachments: z.array(z.object({ filename: z.string().max(200).nullish(), contentType: z.string().max(100).nullish(), base64: z.string().min(1) })).max(3).default([]),
});
export type TestMessage = z.infer<typeof TestMessageBody>;

/** Base64 image attachments are ~4/3 their size; three at the 10 MB image limit fit. */
export const TEST_MESSAGE_MAX_BYTES = 42 * 1024 * 1024;

export type InjectResult = { ok: true; outcome: IngestOutcome; requestId: string | null } | { ok: false; error: string; status: number };

/**
 * Writes in as a test customer, then hands the work to the dispatcher exactly as the Resend webhook does.
 * Without Inngest (local development) the outbox is drained inline instead, like the simulator.
 */
export async function injectTestMessage(body: TestMessage, actor: string): Promise<InjectResult> {
  const e = env();
  const { db } = await getDb();
  const built = await buildTestInbound(
    db,
    e,
    {
      from: body.from,
      fromName: body.name,
      subject: body.subject,
      text: body.text,
      replyToRequestId: body.replyToRequestId,
      quote: body.quote,
      attachments: body.attachments.map((a) => ({ filename: a.filename ?? null, contentType: a.contentType ?? null, bytes: new Uint8Array(Buffer.from(a.base64, 'base64')) })),
    },
    new Date(),
  );
  if (!built.ok) return { ok: false, error: built.error, status: built.error === 'test_mode_off' ? 409 : built.error === 'request_not_found' ? 404 : 422 };
  const c = await getConcierge();
  const outcome = await c.ingestInbound(built.message);
  await audit(db, { actor, action: 'test_mode.inbound_injected', entityKind: 'message', entityId: outcome.messageId, diff: { outcome: outcome.kind, reply: !!body.replyToRequestId, attachments: body.attachments.length } });
  if (e.INNGEST_EVENT_KEY) {
    // Best-effort immediate kick; the per-minute dispatcher covers a lost publish.
    inngest.send(outboxKick.create({ reason: 'test_mode.inbound' })).catch(() => undefined);
  } else {
    for (let i = 0; i < 8; i++) {
      const r = await runOutboxBatch(50);
      if (r.processed + r.failed === 0) break;
    }
  }
  return { ok: true, outcome, requestId: outcome.kind === 'queued' ? outcome.requestId : null };
}

const WORKING = ['received', 'interpreting', 'resolving_event', 'researching'];
const IN_FLIGHT_SENDS = ['queued', 'claimed'];

/**
 * A test request as its customer would have seen it: every email in the thread, in order, including the ones
 * test mode recorded instead of sending, plus anything not sent and why. `settled` is false while the system is
 * still working on it, so an agent polls until it is true. Test conversations only.
 */
export async function testTranscript(requestId: string): Promise<Record<string, unknown> | null> {
  const e = env();
  const { db } = await getDb();
  const [req] = await db.select().from(t.requests).where(eq(t.requests.id, requestId));
  if (!req || !(await isTestConversation(db, req.conversationId))) return null;
  const messages = await db.select().from(t.messages).where(eq(t.messages.conversationId, req.conversationId)).orderBy(asc(t.messages.receivedAt));
  const intents = await db.select().from(t.sendIntents).where(eq(t.sendIntents.conversationId, req.conversationId)).orderBy(asc(t.sendIntents.createdAt));
  const [last] = await db.select({ reason: t.requestTransitions.reason }).from(t.requestTransitions).where(eq(t.requestTransitions.requestId, req.id)).orderBy(desc(t.requestTransitions.createdAt)).limit(1);
  const pendingOutbox = await db.select({ id: t.outboxEvents.id }).from(t.outboxEvents).where(and(inArray(t.outboxEvents.entityId, [req.id, ...messages.map((m) => m.id), ...intents.map((i) => i.id)]), inArray(t.outboxEvents.state, ['pending', 'leased']))).limit(1);
  const [draft] = await db.select().from(t.recommendations).where(and(eq(t.recommendations.requestId, req.id), eq(t.recommendations.reviewStatus, 'pending'), eq(t.recommendations.revision, req.currentRevision))).limit(1);
  const classOf = new Map(intents.filter((i) => i.providerMessageId).map((i) => [i.providerMessageId!, i.messageClass]));
  const recorded = new Set(messages.map((m) => m.providerEmailId).filter(Boolean));
  const s = stateInfo(req.state);
  const settled = !WORKING.includes(req.state) && !intents.some((i) => IN_FLIGHT_SENDS.includes(i.state)) && pendingOutbox.length === 0;
  return {
    requestId: req.id,
    conversationId: req.conversationId,
    state: req.state,
    stateLabel: s.label,
    next: s.next,
    why: reasonText(last?.reason, req.state) || null,
    revision: req.currentRevision,
    settled,
    adminUrl: `${e.APP_URL.replace(/\/$/, '')}/admin/requests/${req.id}`,
    messages: messages.map((m) => ({
      direction: m.direction === 'outbound' ? 'from_ticket_guy' : 'from_customer',
      at: m.receivedAt.toISOString(),
      from: m.fromAddress,
      to: m.toAddresses,
      subject: m.subject,
      kind: m.direction === 'outbound' ? sendClassLabel(classOf.get(m.providerEmailId ?? '') ?? '') || null : null,
      // Outbound here was recorded by test mode (or, before test mode, really sent); inbound is what the customer wrote, quotes stripped.
      recordedByTestMode: m.direction === 'outbound' ? m.provider === TEST_PROVIDER : undefined,
      text: m.sanitizedText ?? '',
    })),
    notSent: intents
      .filter((i) => !i.providerMessageId || !recorded.has(i.providerMessageId))
      .map((i) => ({ at: i.createdAt.toISOString(), kind: sendClassLabel(i.messageClass), state: i.state, reasons: i.lastError ? i.lastError.split(',') : [], subject: i.subject, text: i.bodyText })),
    draftAwaitingApproval: draft ? { subject: draft.subject, text: draft.bodyText } : null,
  };
}
