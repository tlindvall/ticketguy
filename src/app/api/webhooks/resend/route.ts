import { createHash } from 'node:crypto';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { verifySvixSignature } from '@/lib/email/webhook-verify';
import { enqueueOutbox } from '@/lib/intake/outbox';
import { applyProviderStatus } from '@/lib/email/send-intents';
import { applyProviderComplaintOrBounce } from '@/lib/domain/suppression';
import { normalizeEmailLookup } from '@/lib/intake/threading';
import { inngest, outboxKick } from '@/inngest/client';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/resend — signature on raw bytes → unique inbound event + outbox row in one transaction →
 * 2xx only after commit. Duplicates return 2xx without work. DB failure → 503 (provider retries).
 */
export async function POST(req: Request) {
  const e = env();
  if (!e.RESEND_WEBHOOK_SECRET) return Response.json({ error: 'webhook_not_configured' }, { status: 503 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.byteLength > 256 * 1024) return Response.json({ error: 'payload_too_large' }, { status: 413 });
  const v = verifySvixSignature({ rawBody: raw, headers: { 'svix-id': req.headers.get('svix-id') ?? undefined, 'svix-timestamp': req.headers.get('svix-timestamp') ?? undefined, 'svix-signature': req.headers.get('svix-signature') ?? undefined }, secret: e.RESEND_WEBHOOK_SECRET });
  if (!v.ok) return Response.json({ error: 'invalid_signature', reason: v.reason }, { status: 401 });
  let payload: { type?: string; data?: Record<string, unknown> };
  try {
    payload = JSON.parse(raw.toString('utf8')) as { type?: string; data?: Record<string, unknown> };
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const type = String(payload.type ?? 'unknown');
  const payloadHash = createHash('sha256').update(raw).digest('hex');
  try {
    const { db } = await getDb();
    const result = await db.transaction(async (tx) => {
      const inserted = await tx.insert(t.inboundEvents).values({ provider: 'resend', providerEventId: v.id, eventType: type, payloadHash, payload: payload as Record<string, unknown>, signatureVerified: true }).onConflictDoNothing({ target: [t.inboundEvents.provider, t.inboundEvents.providerEventId] }).returning({ id: t.inboundEvents.id });
      if (!inserted.length) return { duplicate: true as const };
      const id = inserted[0]!.id;
      if (type === 'email.received') {
        await enqueueOutbox(tx, { eventType: 'email.received', eventKey: `received:${v.id}`, entityId: id, payload: { inboundEventId: id } });
      } else if (['email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed'].includes(type)) {
        const data = (payload.data ?? {}) as { email_id?: string; to?: string[]; bounce?: { type?: string } };
        const status = type === 'email.delivered' ? 'delivered' : type === 'email.delivery_delayed' ? 'delayed' : type === 'email.bounced' ? 'bounced' : type === 'email.complained' ? 'complained' : 'failed';
        if (data.email_id) await applyProviderStatus(tx, { providerMessageId: data.email_id, status });
        if ((status === 'bounced' && data.bounce?.type !== 'Transient') || status === 'complained') {
          for (const to of data.to ?? []) await applyProviderComplaintOrBounce(tx, { emailLookup: normalizeEmailLookup(to), kind: status === 'complained' ? 'complaint' : 'hard_bounce', provider: 'resend' });
        }
        await tx.update(t.inboundEvents).set({ processingState: 'processed', processedAt: new Date() }).where(sql`${t.inboundEvents.id} = ${id}`);
      } else {
        await tx.update(t.inboundEvents).set({ processingState: 'processed', processedAt: new Date() }).where(sql`${t.inboundEvents.id} = ${id}`);
      }
      return { duplicate: false as const, id };
    });
    if (!result.duplicate && type === 'email.received' && e.INNGEST_EVENT_KEY) {
      // Best-effort immediate kick; the per-minute recovery dispatcher covers a lost publish.
      inngest.send(outboxKick.create({ reason: 'email.received' })).catch(() => undefined);
    }
    return Response.json({ ok: true, duplicate: result.duplicate }, { status: 200 });
  } catch {
    return Response.json({ error: 'storage_unavailable' }, { status: 503 });
  }
}
import { sql } from 'drizzle-orm';
