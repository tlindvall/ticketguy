import { eq, lte, and, sql } from 'drizzle-orm';
import { cron } from 'inngest';
import { inngest, outboxKick } from './client';
import { getConcierge } from '@/lib/services';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { leaseDueOutbox, markDispatched, markFailed } from '@/lib/intake/outbox';
import { fetchReceivedEmail, downloadAttachments, normalizeReceived } from '@/lib/email/resend';
import { audit } from '@/lib/util/audit';

/**
 * Durable workflows. Each step retrieves data by ID; nothing large is checkpointed. Handlers are idempotent
 * because the underlying operations key on message/request/intent IDs and the outbox event key.
 */

/** Recovery dispatcher: every minute lease due outbox rows and run them (crash-safe, at-least-once, idempotent handlers). */
export const dispatchOutbox = inngest.createFunction(
  { id: 'dispatch-outbox', concurrency: { limit: 1 }, triggers: [cron('* * * * *'), outboxKick] },
  async ({ step }) => {
    return step.run('lease-and-run', async () => runOutboxBatch(50));
  },
);

export async function runOutboxBatch(limit: number): Promise<{ processed: number; failed: number }> {
  const { db } = await getDb();
  const c = await getConcierge();
  const now = new Date();
  const leased = await leaseDueOutbox(db, { limit, now });
  let failed = 0;
  for (const ev of leased) {
    try {
      const p = ev.payload as Record<string, string>;
      switch (ev.eventType) {
        case 'email.received':
          await ingestFromProvider(p.inboundEventId!);
          break;
        case 'request.interpret':
          await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          break;
        case 'research.requested':
          await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          break;
        case 'email.send_requested':
          await c.dispatchSend(p.sendIntentId!);
          break;
        case 'recommendation.review_ready':
        case 'advice.prepare':
        case 'watch.evaluate':
        case 'watch.due':
        case 'contact.delete_requested':
        case 'retention.due':
          break; // informational / handled by scheduled functions
        default:
          throw new Error(`unknown outbox event type ${ev.eventType}`);
      }
      await markDispatched(db, ev.id, ev.leaseToken, new Date());
    } catch (e) {
      failed += 1;
      const r = await markFailed(db, ev, e instanceof Error ? e.message : String(e), new Date());
      await audit(db, { actor: 'system', action: r === 'dead' ? 'outbox.dead_lettered' : 'outbox.retry_scheduled', entityKind: 'outbox_event', entityId: ev.id, diff: { eventType: ev.eventType, attempts: ev.attempts } });
    }
  }
  return { processed: leased.length - failed, failed };
}

/** Resend metadata → authenticated retrieval → bounded attachment download → normalized ingest. */
export async function ingestFromProvider(inboundEventId: string): Promise<void> {
  const { db } = await getDb();
  const e = env();
  const c = await getConcierge();
  const [ev] = await db.select().from(t.inboundEvents).where(eq(t.inboundEvents.id, inboundEventId));
  if (!ev || ev.processingState !== 'pending') return;
  if (!e.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing; cannot retrieve received email');
  const data = (ev.payload as { data?: { email_id?: string; id?: string } }).data ?? {};
  const emailId = data.email_id ?? data.id;
  if (!emailId) {
    await db.update(t.inboundEvents).set({ processingState: 'quarantined', quarantineReason: 'no_email_id' }).where(eq(t.inboundEvents.id, ev.id));
    return;
  }
  const detail = await fetchReceivedEmail(e.RESEND_API_KEY, emailId);
  const { attachments, skipped } = await downloadAttachments(detail);
  const normalized = normalizeReceived(detail, attachments, ev.signatureVerified);
  const outcome = await c.ingestInbound(normalized);
  await db.update(t.inboundEvents).set({ processingState: 'processed', processedAt: new Date() }).where(eq(t.inboundEvents.id, ev.id));
  await audit(db, { actor: 'system', action: 'inbound.provider_ingested', entityKind: 'inbound_event', entityId: ev.id, diff: { outcome: outcome.kind, skippedAttachments: skipped } });
}

export const evaluateWatches = inngest.createFunction(
  { id: 'evaluate-due-watches', concurrency: { limit: 1 }, triggers: [cron('*/5 * * * *')] },
  async ({ step }) => {
    return step.run('evaluate', async () => {
      const e = env();
      const c = await getConcierge();
      if (!e.WATCH_SEND_ENABLED && e.APP_MODE !== 'fixture') return { skipped: 'watches_disabled' };
      return c.evaluateDueWatches(20);
    });
  },
);

/** Retention: purge raw bodies/attachments past purge_at; expire media; observations past retention. */
export const retentionSweep = inngest.createFunction(
  { id: 'retention-sweep', concurrency: { limit: 1 }, triggers: [cron('17 3 * * *')] },
  async ({ step }) => {
    return step.run('sweep', async () => runRetentionSweep(new Date()));
  },
);

export async function runRetentionSweep(now: Date): Promise<{ mediaDeleted: number; attachmentsPurged: number; observationsPurged: number }> {
  const { db } = await getDb();
  const media = await db.delete(t.mediaObjects).where(lte(t.mediaObjects.expiresAt, now)).returning({ id: t.mediaObjects.id });
  const atts = await db.update(t.attachments).set({ mediaId: null, validationState: 'purged' }).where(and(lte(t.attachments.purgeAt, now), sql`${t.attachments.mediaId} is not null`)).returning({ id: t.attachments.id });
  await db.update(t.messages).set({ rawMediaId: null }).where(lte(t.messages.purgeAt, now));
  const obs = await db.delete(t.offerObservations).where(and(lte(t.offerObservations.retentionUntil, now), sql`${t.offerObservations.id} not in (select unnest(chosen_observation_ids::text[])::uuid from ${t.recommendations} where review_status in ('pending','approved'))`)).returning({ id: t.offerObservations.id });
  await audit(db, { actor: 'system', action: 'retention.sweep', entityKind: 'system', entityId: 'retention', diff: { media: media.length, attachments: atts.length, observations: obs.length } });
  return { mediaDeleted: media.length, attachmentsPurged: atts.length, observationsPurged: obs.length };
}

export const functions = [dispatchOutbox, evaluateWatches, retentionSweep];
