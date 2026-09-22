import { eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import { killSwitches, suppressions } from '@/lib/db/schema';
import type { Env } from '@/lib/config/env';

/**
 * Send gate (API_AND_DATA_CONTRACTS §5). Evaluated immediately before every provider submission, using
 * the CURRENT switch state, never a cached scheduling decision (A38). Fixture mode can never pass (A13).
 */
export type MessageClass = 'acknowledgment' | 'clarification' | 'recommendation' | 'no_result' | 'watch_confirmation' | 'watch_alert' | 'marketing' | 'verification';

export type GateInput = {
  messageClass: MessageClass;
  recipientLookup: string;
  /** Whether the content is derived from fixture data (collectionMode 'fixture' anywhere in its evidence). */
  containsFixtureData: boolean;
  /** Approval state for classes that require human approval. */
  approved: boolean;
  /** Approval hash matches the content hash being sent. */
  approvalHashMatches: boolean;
  /** Current request/watch revision matches the revision the content was prepared for. */
  revisionCurrent: boolean;
  /** Fresh offer evidence (A27) where applicable. */
  evidenceFresh: boolean;
  /** Active marketing permission for marketing sends. */
  marketingPermission: boolean;
};

export type GateResult = { allowed: true } | { allowed: false; reasons: string[] };

const REQUIRES_APPROVAL: MessageClass[] = ['recommendation', 'watch_alert', 'marketing'];

export async function loadSwitches(db: DbOrTx): Promise<Record<string, boolean>> {
  const rows = await db.select({ key: killSwitches.key, enabled: killSwitches.enabled }).from(killSwitches);
  return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
}

export async function loadSuppressionScopes(db: DbOrTx, recipientLookup: string): Promise<Set<string>> {
  const rows = await db.select({ scope: suppressions.scope }).from(suppressions).where(eq(suppressions.emailLookup, recipientLookup));
  return new Set(rows.map((r) => r.scope));
}

export function evaluateGate(env: Env, switches: Record<string, boolean>, suppressed: Set<string>, input: GateInput): GateResult {
  const reasons: string[] = [];
  if (env.APP_MODE === 'fixture') reasons.push('app_mode_fixture');
  if (!env.EMAIL_SEND_ENABLED) reasons.push('email_send_disabled');
  if (input.containsFixtureData) reasons.push('content_contains_fixture_data');
  if (switches['all_outbound'] === false) reasons.push('kill_switch_all_outbound');
  if (input.messageClass === 'recommendation' && switches['recommendations'] === false) reasons.push('kill_switch_recommendations');
  if (input.messageClass === 'marketing') {
    if (!env.MARKETING_SEND_ENABLED) reasons.push('marketing_send_disabled');
    if (switches['marketing'] === false) reasons.push('kill_switch_marketing');
    if (!input.marketingPermission) reasons.push('no_marketing_permission');
    if (suppressed.has('marketing')) reasons.push('suppressed_marketing');
  }
  if (input.messageClass === 'watch_alert' || input.messageClass === 'watch_confirmation') {
    if (!env.WATCH_SEND_ENABLED) reasons.push('watch_send_disabled');
    if (switches['watches'] === false) reasons.push('kill_switch_watches');
    if (suppressed.has('watch')) reasons.push('suppressed_watch');
  }
  if (suppressed.has('global')) reasons.push('suppressed_global');
  if (env.EMAIL_TEST_RECIPIENT_ALLOWLIST.length > 0 && !env.EMAIL_TEST_RECIPIENT_ALLOWLIST.includes(input.recipientLookup)) reasons.push('recipient_not_in_test_allowlist');
  if (REQUIRES_APPROVAL.includes(input.messageClass) || env.HUMAN_REVIEW_REQUIRED && input.messageClass !== 'acknowledgment' && input.messageClass !== 'clarification' && input.messageClass !== 'verification' && input.messageClass !== 'no_result') {
    if (!input.approved) reasons.push('not_approved');
    if (!input.approvalHashMatches) reasons.push('approval_hash_mismatch');
  }
  if (!input.revisionCurrent) reasons.push('revision_stale');
  if ((input.messageClass === 'recommendation' || input.messageClass === 'watch_alert') && !input.evidenceFresh) reasons.push('evidence_stale');
  return reasons.length ? { allowed: false, reasons } : { allowed: true };
}

export async function setKillSwitch(db: DbOrTx, key: string, enabled: boolean, changedBy: string, reason: string | null): Promise<void> {
  await db
    .insert(killSwitches)
    .values({ key, enabled, changedBy, reason, changedAt: new Date() })
    .onConflictDoUpdate({ target: killSwitches.key, set: { enabled, changedBy, reason, changedAt: new Date() } });
}

export const DEFAULT_SWITCHES = ['all_outbound', 'recommendations', 'marketing', 'watches', 'escalation_model'];

export async function ensureDefaultSwitches(db: DbOrTx): Promise<void> {
  const existing = await db.select({ key: killSwitches.key }).from(killSwitches).where(inArray(killSwitches.key, DEFAULT_SWITCHES));
  const have = new Set(existing.map((r) => r.key));
  const missing = DEFAULT_SWITCHES.filter((k) => !have.has(k));
  if (missing.length) await db.insert(killSwitches).values(missing.map((key) => ({ key, enabled: true, changedBy: 'system', reason: 'default' }))).onConflictDoNothing();
}
