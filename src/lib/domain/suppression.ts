import type { DbOrTx } from '@/lib/db';
import { suppressions, marketingPermissions, watches, eventAlerts } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * Suppression policy (ENGINEERING_SPEC §9, A31/A32). Hard bounces/complaints → global. "unsubscribe" →
 * marketing. "stop all emails" → marketing + watch (and cancels active watches). Idempotent.
 */
export type SuppressionScope = 'global' | 'marketing' | 'watch';

/** `at` is the caller's clock, so an opt-out confirmed later reads the date it was recorded on that clock. */
export async function addSuppression(db: DbOrTx, args: { emailLookup: string; scope: SuppressionScope; reason: string; provider?: string | null; at?: Date }): Promise<void> {
  await db.insert(suppressions).values({ emailLookup: args.emailLookup, scope: args.scope, reason: args.reason, provider: args.provider ?? null, ...(args.at ? { createdAt: args.at } : {}) }).onConflictDoNothing();
}

export async function revokeMarketing(db: DbOrTx, args: { contactId: string | null; emailLookup: string; method: 'preference_form' | 'natural_language' | 'one_click' | 'staff'; evidence: Record<string, unknown>; noticeVersion: string; at?: Date }): Promise<void> {
  await addSuppression(db, { emailLookup: args.emailLookup, scope: 'marketing', reason: 'unsubscribe', at: args.at });
  if (args.contactId) {
    await db.insert(marketingPermissions).values({ contactId: args.contactId, topic: 'ticket_offers', status: 'revoked', noticeVersion: args.noticeVersion, method: args.method, evidence: args.evidence, revokedAt: args.at ?? new Date() });
  }
}

export async function stopAll(db: DbOrTx, args: { contactId: string | null; emailLookup: string; evidence: Record<string, unknown>; at?: Date }): Promise<void> {
  await revokeMarketing(db, { ...args, method: 'natural_language', noticeVersion: 'n/a' });
  await addSuppression(db, { emailLookup: args.emailLookup, scope: 'watch', reason: 'stop_all', at: args.at });
  if (args.contactId) {
    await db.update(watches).set({ state: 'cancelled' }).where(and(eq(watches.contactId, args.contactId), eq(watches.state, 'active')));
    await db.update(eventAlerts).set({ state: 'cancelled' }).where(and(eq(eventAlerts.contactId, args.contactId), eq(eventAlerts.state, 'active')));
  }
}

export async function applyProviderComplaintOrBounce(db: DbOrTx, args: { emailLookup: string; kind: 'hard_bounce' | 'complaint'; provider: string }): Promise<void> {
  await addSuppression(db, { emailLookup: args.emailLookup, scope: 'global', reason: args.kind, provider: args.provider });
}

/** Natural-language intent classification for opt-out text (deterministic; no model needed). */
export function classifyOptOutText(text: string): 'stop_all' | 'unsubscribe_marketing' | null {
  const t = text.toLowerCase();
  // "stop emailing me", "I don't want ticket suggestions, price-watch emails or marketing emails" (TGQA-R6 1014).
  const u = t.replace(/[’‘]/g, "'");
  if (/\b(stop all( emails| messages)?|stop everything|no more emails at all|do not (email|contact) me (again|anymore)|stop (emailing|messaging|contacting|writing to) me|(don'?t|do not) (email|contact|message) me|don'?t want (any )?(more )?(ticket suggestions|emails from you)|no more emails)\b/.test(u)) return 'stop_all';
  // "I do not want ticket suggestions, price-watch emails or marketing emails": more than marketing is stopped (TGQA-R8 S09).
  if (/\b(?:don'?t|do not|no longer) want\b[^.?!]{0,80}\b(?:ticket suggestions|suggestions|price[- ]watch(?:es| emails)?|alerts?|follow[- ]ups?)\b/.test(u)) return 'stop_all';
  if (/\bunsubscribe\b|\bopt[- ]?out\b|\bremove me from (your|the) (list|mailing)\b|\bno (more )?(promotions|marketing|deals)\b/.test(t)) return 'unsubscribe_marketing';
  return null;
}

/** "Please confirm what you stopped", "Have you recorded that preference?": a question about the stops on file. */
export function asksAboutOptOut(text: string): boolean {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  return /\b(?:confirm|recorded|what you(?:'ve)? stopped|have you stopped|did you stop|is (?:that|it) (?:recorded|saved|on file))\b/.test(t) && /\b(?:stop(?:ped)?|preferences?|emails?|suggestions|marketing|alerts?|unsubscribe[sd]?|opt(?:ed)?[- ]?out)\b/.test(t) && !/\b(?:delet\w*|erase)\b/.test(t);
}
