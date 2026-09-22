import { and, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { DbOrTx } from '@/lib/db';
import { sendIntents } from '@/lib/db/schema';
import type { MessageClass } from './send-gate';

/**
 * Immutable send intents (A17/A18/A19). One logical send = one dedupe key = one payload = one provider
 * idempotency key. Retries reuse the key and byte-identical payload. Uncertain outcomes older than the
 * provider's 24h idempotency window are never blindly resent.
 */
export const PROVIDER_IDEMPOTENCY_WINDOW_HOURS = 24;

export type SendIntentInput = {
  dedupeKey: string;
  messageClass: MessageClass;
  contactId: string | null;
  conversationId: string | null;
  requestId: string | null;
  requestRevision: number | null;
  approvalId: string | null;
  approvedHash: string | null;
  recipient: string;
  fromAddress: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  headers: Record<string, string>;
};

export function contentHash(i: Pick<SendIntentInput, 'recipient' | 'fromAddress' | 'subject' | 'bodyText' | 'bodyHtml' | 'headers'>): string {
  return createHash('sha256').update(JSON.stringify([i.recipient, i.fromAddress, i.subject, i.bodyText, i.bodyHtml, Object.entries(i.headers).sort()])).digest('hex');
}

export async function createSendIntent(tx: DbOrTx, input: SendIntentInput): Promise<{ id: string; created: boolean }> {
  const hash = contentHash(input);
  const rows = await tx
    .insert(sendIntents)
    .values({ ...input, contentHash: hash })
    .onConflictDoNothing({ target: sendIntents.dedupeKey })
    .returning({ id: sendIntents.id });
  if (rows.length) return { id: rows[0]!.id, created: true };
  const existing = await tx.select({ id: sendIntents.id }).from(sendIntents).where(eq(sendIntents.dedupeKey, input.dedupeKey));
  return { id: existing[0]!.id, created: false };
}

export type Claim = { id: string; claimToken: string } | null;

/** Atomic claim: only one worker may submit a given intent. */
export async function claimSendIntent(db: DbOrTx, id: string, now: Date): Promise<Claim> {
  const token = randomUUID();
  const rows = await db
    .update(sendIntents)
    .set({ state: 'claimed', claimToken: token, claimedAt: now, attempts: sql`${sendIntents.attempts} + 1` })
    .where(and(eq(sendIntents.id, id), eq(sendIntents.state, 'queued')))
    .returning({ id: sendIntents.id });
  return rows.length ? { id, claimToken: token } : null;
}

export async function releaseClaim(db: DbOrTx, claim: { id: string; claimToken: string }, toState: 'queued' | 'blocked' | 'suppressed' | 'failed' | 'uncertain', error: string | null): Promise<void> {
  await db
    .update(sendIntents)
    .set({ state: toState, claimToken: null, lastError: error, resolvedAt: toState === 'queued' ? null : new Date() })
    .where(and(eq(sendIntents.id, claim.id), eq(sendIntents.claimToken, claim.claimToken)));
}

export async function recordProviderAccepted(db: DbOrTx, claim: { id: string; claimToken: string }, providerMessageId: string, now: Date): Promise<void> {
  // A19: a delivery webhook may already have upserted 'delivered' by provider id; never regress it.
  await db.execute(sql`
    update ${sendIntents}
      set provider_message_id = ${providerMessageId},
          submitted_at = ${now.toISOString()}::timestamptz,
          claim_token = null,
          state = case when state in ('delivered','bounced','complained') then state else 'provider_accepted' end
    where id = ${claim.id} and (claim_token = ${claim.claimToken} or claim_token is null)
  `);
}

const TERMINAL_RANK: Record<string, number> = { queued: 0, claimed: 1, provider_accepted: 2, delayed: 3, delivered: 4, bounced: 5, complained: 6 };

/** Provider status webhooks: out-of-order events must not erase a bounce or complaint. */
export async function applyProviderStatus(db: DbOrTx, args: { providerMessageId: string; status: 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed'; providerRfcMessageId?: string | null }): Promise<'applied' | 'ignored' | 'unknown_message'> {
  const rows = await db.select({ id: sendIntents.id, state: sendIntents.state }).from(sendIntents).where(eq(sendIntents.providerMessageId, args.providerMessageId));
  const row = rows[0];
  if (!row) return 'unknown_message';
  const currentRank = TERMINAL_RANK[row.state] ?? 0;
  const newRank = TERMINAL_RANK[args.status] ?? 0;
  if (args.status !== 'failed' && newRank < currentRank) return 'ignored';
  await db
    .update(sendIntents)
    .set({ state: args.status, resolvedAt: new Date(), ...(args.providerRfcMessageId ? { providerRfcMessageId: args.providerRfcMessageId } : {}) })
    .where(eq(sendIntents.id, row.id));
  return 'applied';
}

/** A19: delivery webhook before the API response: pre-create the mapping keyed by provider id. */
export async function upsertProviderMapping(db: DbOrTx, args: { providerMessageId: string; dedupeKeyHint: string | null; status: 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' }): Promise<'applied' | 'deferred'> {
  const r = await applyProviderStatus(db, { providerMessageId: args.providerMessageId, status: args.status });
  if (r !== 'unknown_message') return 'applied';
  if (!args.dedupeKeyHint) return 'deferred';
  const rows = await db.update(sendIntents).set({ providerMessageId: args.providerMessageId, state: args.status, resolvedAt: new Date() }).where(and(eq(sendIntents.dedupeKey, args.dedupeKeyHint))).returning({ id: sendIntents.id });
  return rows.length ? 'applied' : 'deferred';
}

/**
 * A17/A18: decide what to do with an intent whose previous attempt is uncertain.
 * Within the provider idempotency window → retry with the SAME key/payload. Beyond → manual reconciliation.
 */
export function uncertainRetryDecision(args: { firstSubmittedAt: Date | null; now: Date }): 'retry_same_key' | 'manual_reconciliation' {
  if (!args.firstSubmittedAt) return 'retry_same_key';
  const ageHours = (args.now.getTime() - args.firstSubmittedAt.getTime()) / 3_600_000;
  return ageHours < PROVIDER_IDEMPOTENCY_WINDOW_HOURS ? 'retry_same_key' : 'manual_reconciliation';
}
