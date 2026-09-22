import type { DbOrTx } from '@/lib/db';
import { suppressions, marketingPermissions, watches } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * Suppression policy (ENGINEERING_SPEC §9, A31/A32). Hard bounces/complaints → global. "unsubscribe" →
 * marketing. "stop all emails" → marketing + watch (and cancels active watches). Idempotent.
 */
export type SuppressionScope = 'global' | 'marketing' | 'watch';

export async function addSuppression(db: DbOrTx, args: { emailLookup: string; scope: SuppressionScope; reason: string; provider?: string | null }): Promise<void> {
  await db.insert(suppressions).values({ emailLookup: args.emailLookup, scope: args.scope, reason: args.reason, provider: args.provider ?? null }).onConflictDoNothing();
}

export async function revokeMarketing(db: DbOrTx, args: { contactId: string | null; emailLookup: string; method: 'preference_form' | 'natural_language' | 'one_click' | 'staff'; evidence: Record<string, unknown>; noticeVersion: string }): Promise<void> {
  await addSuppression(db, { emailLookup: args.emailLookup, scope: 'marketing', reason: 'unsubscribe' });
  if (args.contactId) {
    await db.insert(marketingPermissions).values({ contactId: args.contactId, topic: 'ticket_offers', status: 'revoked', noticeVersion: args.noticeVersion, method: args.method, evidence: args.evidence, revokedAt: new Date() });
  }
}

export async function stopAll(db: DbOrTx, args: { contactId: string | null; emailLookup: string; evidence: Record<string, unknown> }): Promise<void> {
  await revokeMarketing(db, { ...args, method: 'natural_language', noticeVersion: 'n/a' });
  await addSuppression(db, { emailLookup: args.emailLookup, scope: 'watch', reason: 'stop_all' });
  if (args.contactId) {
    await db.update(watches).set({ state: 'cancelled' }).where(and(eq(watches.contactId, args.contactId), eq(watches.state, 'active')));
  }
}

export async function applyProviderComplaintOrBounce(db: DbOrTx, args: { emailLookup: string; kind: 'hard_bounce' | 'complaint'; provider: string }): Promise<void> {
  await addSuppression(db, { emailLookup: args.emailLookup, scope: 'global', reason: args.kind, provider: args.provider });
}

/** Natural-language intent classification for opt-out text (deterministic; no model needed). */
export function classifyOptOutText(text: string): 'stop_all' | 'unsubscribe_marketing' | null {
  const t = text.toLowerCase();
  if (/\b(stop all( emails| messages)?|stop everything|no more emails at all|do not (email|contact) me (again|anymore))\b/.test(t)) return 'stop_all';
  if (/\bunsubscribe\b|\bopt[- ]?out\b|\bremove me from (your|the) (list|mailing)\b|\bno (more )?(promotions|marketing|deals)\b/.test(t)) return 'unsubscribe_marketing';
  return null;
}
