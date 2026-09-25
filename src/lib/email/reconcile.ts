import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { enqueueOutbox } from '@/lib/intake/outbox';
import { audit } from '@/lib/util/audit';
import { providerErrorDetail } from './resend';

/**
 * Inbound reconciliation: the provider's own list of received mail against what the webhook delivered.
 *
 * The webhook is the only way mail enters the system, and once it silently lost its `email.received`
 * subscription for twenty hours; five customer emails sat at the provider with nothing pointing at them
 * and no replay. This sweep asks the provider what it received, finds any message no inbound event or
 * stored message accounts for, and queues each one through the ordinary retrieval path — the same
 * `ingestFromProvider` a webhook would have triggered, so nothing downstream can tell the difference.
 *
 * The listing endpoint's response shape has not been seen from this environment. The parser therefore
 * accepts only the shapes it can name and fails loudly on anything else: a sweep that quietly reads zero
 * items is worse than one that reports it could not read the list. Ids and timestamps are the only values
 * ever read from the listing; a sender, subject or body is never touched here.
 */
export type ReceivedListing = { id: string; createdAt: string | null };

export class ReceivedListError extends Error {
  constructor(
    readonly kind: 'http' | 'unrecognized',
    message: string,
  ) {
    super(message);
  }
}

export async function listReceivedEmails(apiKey: string, opts: { limit?: number; fetchImpl?: typeof fetch } = {}): Promise<ReceivedListing[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const res = await fetchImpl(`https://api.resend.com/emails/receiving?limit=${limit}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new ReceivedListError('http', `resend_receive_list_failed:${res.status}${await providerErrorDetail(res)}`);
  const body = (await res.json()) as unknown;
  const items = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data) ? ((body as { data: unknown[] }).data as unknown[]) : null;
  if (!items) throw new ReceivedListError('unrecognized', `resend_receive_list_unrecognized:envelope_keys=${body && typeof body === 'object' ? Object.keys(body as object).sort().join(',') : typeof body}`);
  const out: ReceivedListing[] = [];
  for (const item of items) {
    const r = (item ?? {}) as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : typeof r.email_id === 'string' ? r.email_id : null;
    if (!id) throw new ReceivedListError('unrecognized', `resend_receive_list_unrecognized:item_keys=${Object.keys(r).sort().join(',')}`);
    const createdAt = typeof r.created_at === 'string' ? r.created_at : typeof r.received_at === 'string' ? r.received_at : null;
    out.push({ id, createdAt });
  }
  return out;
}

export type ReconcileOutcome = {
  listed: number;
  /** Provider ids already covered by an inbound event or a stored inbound message. */
  known: number;
  /** Provider ids nothing accounts for. Populated in dry run and apply alike. */
  missing: string[];
  /** Inbound events written and queued this run (0 in dry run). */
  enqueued: number;
};

/** Provider ids the system already knows about, from either the webhook event or the stored message. */
async function knownProviderIds(db: DbOrTx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const known = new Set<string>();
  const emailIdExpr = sql<string>`coalesce(${t.inboundEvents.payload}->'data'->>'email_id', ${t.inboundEvents.payload}->'data'->>'id')`;
  for (const r of await db
    .select({ id: emailIdExpr })
    .from(t.inboundEvents)
    .where(and(eq(t.inboundEvents.provider, 'resend'), eq(t.inboundEvents.eventType, 'email.received'), inArray(emailIdExpr, ids)))) {
    if (r.id) known.add(r.id);
  }
  for (const r of await db
    .select({ id: t.messages.providerEmailId })
    .from(t.messages)
    .where(and(eq(t.messages.provider, 'resend'), eq(t.messages.direction, 'inbound'), inArray(t.messages.providerEmailId, ids)))) {
    if (r.id) known.add(r.id);
  }
  return known;
}

export async function reconcileReceived(db: DbOrTx, args: { apiKey: string; apply: boolean; limit?: number; fetchImpl?: typeof fetch; now?: Date; actor?: string }): Promise<ReconcileOutcome> {
  const now = args.now ?? new Date();
  const listing = await listReceivedEmails(args.apiKey, { limit: args.limit, fetchImpl: args.fetchImpl });
  const ids = [...new Set(listing.map((l) => l.id))];
  const known = await knownProviderIds(db, ids);
  const missing = listing.filter((l) => !known.has(l.id));
  let enqueued = 0;
  if (args.apply) {
    for (const m of missing) {
      // The event row is shaped like the webhook's metadata-only payload so `ingestFromProvider` takes its
      // retrieval path unchanged. `signatureVerified` is false because no provider signature was checked —
      // the retrieval itself is authenticated by the API key — and the flag is recorded, not acted on.
      const payload = { type: 'email.received', reconciled: true, data: { email_id: m.id, created_at: m.createdAt } };
      const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const inserted = await db
        .insert(t.inboundEvents)
        .values({ provider: 'resend', providerEventId: `reconcile:${m.id}`, eventType: 'email.received', payloadHash, payload, signatureVerified: false, receivedAt: now })
        .onConflictDoNothing({ target: [t.inboundEvents.provider, t.inboundEvents.providerEventId] })
        .returning({ id: t.inboundEvents.id });
      if (!inserted.length) continue;
      const id = inserted[0]!.id;
      const q = await enqueueOutbox(db, { eventType: 'email.received', eventKey: `received:reconcile:${m.id}`, entityId: id, payload: { inboundEventId: id }, now });
      if (q.inserted) enqueued += 1;
      await audit(db, { actor: args.actor ?? 'system', action: 'inbound.reconciled', entityKind: 'inbound_event', entityId: id, diff: { providerEmailId: m.id, providerCreatedAt: m.createdAt } });
    }
  }
  return { listed: listing.length, known: known.size, missing: missing.map((m) => m.id), enqueued };
}
