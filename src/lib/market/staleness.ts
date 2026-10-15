import { and, desc, eq, gt, gte, inArray, lte, max, min, notInArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import type { Env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { audit } from '@/lib/util/audit';
import { loadSwitches } from '@/lib/email/send-gate';
import { testModeFrom } from '@/lib/email/test-mode';
import { SEATDATA_PROVIDER } from './series';
import { marketLicence } from './tracker';

/**
 * Games a customer asked about that SeatData hasn't checked lately (Oct 11-14: billing showed no requests at all
 * while Rangers requests stayed open and nothing said so). A game counts from when its oldest open request came in,
 * so a request from an hour ago isn't overdue; a check is any successful SeatData read for the game.
 */
export const STALE_HOURS = 36;

export type MarketGap = { eventId: string; name: string; startsAt: Date; askedAt: Date; lastCheckAt: Date | null; tracked: { state: string; lastError: string | null; nextPollAt: Date } | null };

/** What decides whether tracking can run at all, and what the last passes did: the four usual causes, as data. */
export type TrackingDiagnosis = {
  apiKey: boolean;
  licence: { status: string; uses: string[]; tracking: boolean; retentionUntil: Date | null };
  /** The last hourly pass recorded (every pass is, blocked or not); null means the scheduler never ran one. */
  lastPass: { at: Date; skipped: string | null; due: number | null; polled: number | null; stoppedBy: string | null } | null;
  /** The last account-level refusal (auth, subscription, payment), which stops a pass at its first call. */
  lastAccountError: { at: Date; detail: string } | null;
  callsLast7Days: Array<{ day: string; calls: number }>;
};

const ACCOUNT_ERRORS = ['authentication_error%', 'subscription_required%', 'payment_required%'];

export async function marketGaps(db: DbOrTx, now: Date, hours = STALE_HOURS): Promise<MarketGap[]> {
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const asked = await db
    .select({ eventId: t.events.id, name: t.events.name, startsAt: t.events.localStartAt, askedAt: min(t.requests.createdAt) })
    .from(t.requests)
    .innerJoin(t.events, eq(t.events.id, t.requests.eventId))
    .where(and(notInArray(t.requests.state, ['closed', 'unsupported']), eq(t.events.status, 'scheduled'), gt(t.events.localStartAt, now), lte(t.events.localStartAt, new Date(now.getTime() + 180 * 86_400_000)), eq(t.events.isFixture, false)))
    .groupBy(t.events.id, t.events.name, t.events.localStartAt);
  const due = asked.filter((a) => a.askedAt && a.askedAt <= cutoff);
  if (!due.length) return [];
  const ids = due.map((d) => d.eventId);
  const checks = await db.select({ eventId: t.marketFetches.eventId, at: max(t.marketFetches.at) }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), eq(t.marketFetches.status, 'success'), inArray(t.marketFetches.eventId, ids))).groupBy(t.marketFetches.eventId);
  const lastCheck = new Map(checks.map((c) => [c.eventId, c.at]));
  const tracked = await db.select().from(t.trackedEvents).where(and(eq(t.trackedEvents.provider, SEATDATA_PROVIDER), inArray(t.trackedEvents.eventId, ids)));
  const tr = new Map(tracked.map((r) => [r.eventId, r]));
  return due
    .map((d) => ({ eventId: d.eventId, name: d.name, startsAt: d.startsAt, askedAt: d.askedAt!, lastCheckAt: lastCheck.get(d.eventId) ?? null, tracked: tr.has(d.eventId) ? { state: tr.get(d.eventId)!.state, lastError: tr.get(d.eventId)!.lastError, nextPollAt: tr.get(d.eventId)!.nextPollAt } : null }))
    .filter((g) => !g.lastCheckAt || g.lastCheckAt <= cutoff)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export async function trackingDiagnosis(db: DbOrTx, env: Pick<Env, 'SEATDATA_API_KEY'>, now: Date): Promise<TrackingDiagnosis> {
  const lic = await marketLicence(db);
  const [pass] = await db.select({ at: t.auditLog.createdAt, diff: t.auditLog.diff }).from(t.auditLog).where(eq(t.auditLog.action, 'market.tracking_pass')).orderBy(desc(t.auditLog.createdAt)).limit(1);
  const d = (pass?.diff ?? {}) as { skipped?: string; due?: number; polled?: number; stoppedBy?: string };
  const [acct] = await db.select({ at: t.marketFetches.at, detail: t.marketFetches.detail }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), eq(t.marketFetches.status, 'error'), sql`(${sql.join(ACCOUNT_ERRORS.map((p) => sql`${t.marketFetches.detail} like ${p}`), sql` or `)})`)).orderBy(desc(t.marketFetches.at)).limit(1);
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const day = sql<string>`to_char(${t.marketFetches.at} at time zone 'UTC', 'YYYY-MM-DD')`;
  const calls = await db.select({ day, calls: sql<number>`coalesce(sum(${t.marketFetches.calls}), 0)::int` }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), gte(t.marketFetches.at, since))).groupBy(day).orderBy(day);
  return {
    apiKey: !!env.SEATDATA_API_KEY,
    licence: { status: lic.status, uses: lic.uses, tracking: lic.allows('tracking'), retentionUntil: lic.row?.rawRetentionUntil ?? null },
    lastPass: pass ? { at: pass.at, skipped: d.skipped ?? null, due: d.due ?? null, polled: d.polled ?? null, stoppedBy: d.stoppedBy ?? null } : null,
    lastAccountError: acct ? { at: acct.at, detail: acct.detail ?? '' } : null,
    callsLast7Days: calls.map((c) => ({ day: c.day, calls: Number(c.calls) })),
  };
}

/** The most likely reason, first: what stops every game before what stops one. */
export function likelyCause(d: TrackingDiagnosis, gaps: MarketGap[], now: Date): string[] {
  const out: string[] = [];
  if (!d.apiKey) out.push('SEATDATA_API_KEY is not set on the service, so nothing calls SeatData.');
  if (!d.licence.tracking) out.push(d.licence.status === 'approved' && d.licence.retentionUntil && d.licence.retentionUntil <= now ? `The SeatData licence's "keep data until" date (${d.licence.retentionUntil.toISOString().slice(0, 10)}) has passed, which stops tracking.` : `The SeatData licence on /admin/market doesn't allow tracking (status ${d.licence.status}, uses: ${d.licence.uses.join(', ') || 'none'}).`);
  if (!d.lastPass) out.push('No hourly tracking pass has ever been recorded: the track-markets job isn\'t running. Check that Inngest has synced the app since the last deploy (it registers new functions only on a sync), or point a Render cron at POST /api/internal/market-tracking.');
  else if (now.getTime() - d.lastPass.at.getTime() > 3 * 3_600_000) out.push(`The last hourly tracking pass was ${d.lastPass.at.toISOString()}: the track-markets job has stopped firing (Inngest app not synced since a deploy, or its cron paused).`);
  else if (d.lastPass.skipped) out.push(`The hourly pass runs but skips: ${d.lastPass.skipped}.`);
  if (d.lastAccountError && now.getTime() - d.lastAccountError.at.getTime() < 3 * 86_400_000) out.push(`SeatData refused the account at ${d.lastAccountError.at.toISOString()} (${d.lastAccountError.detail.slice(0, 60)}); each pass stops at its first call.`);
  const untracked = gaps.filter((g) => !g.tracked).length;
  if (untracked) out.push(`${untracked} of these games ${untracked === 1 ? 'isn\'t' : 'aren\'t'} enrolled for tracking (the service-depth gate, or no pass has run since the request).`);
  const failing = gaps.filter((g) => g.tracked && ['unmatched', 'paused', 'ended'].includes(g.tracked.state)).length;
  if (failing) out.push(`${failing} ${failing === 1 ? 'is' : 'are'} enrolled but not polled (unmatched on SeatData or paused).`);
  return out.length ? out : ['No single cause found: the passes run and the licence allows tracking. Check each game\'s tracking row on /admin/market.'];
}

/**
 * One staff email a day while any asked-about game is overdue: the games (names and dates only, never customer
 * words), how long since their last check, and the likely cause. Internal mail like the other staff alerts:
 * "stop all outbound" and test mode still stop it.
 */
export async function alertMarketGaps(db: DbOrTx, env: Env, provider: { send: (a: { idempotencyKey: string; from: string; to: string; subject: string; text: string; html: string; headers: Record<string, string> }) => Promise<unknown> } | null, now: Date): Promise<{ outcome: 'sent' | 'none' | 'skipped'; gaps: number; reason?: string }> {
  const gaps = await marketGaps(db, now);
  if (!gaps.length) return { outcome: 'none', gaps: 0 };
  const day = now.toISOString().slice(0, 10);
  const [already] = await db.select({ id: t.auditLog.id }).from(t.auditLog).where(and(eq(t.auditLog.action, 'market.stale_alert'), eq(t.auditLog.entityId, day))).limit(1);
  if (already) return { outcome: 'skipped', gaps: gaps.length, reason: 'already_sent_today' };
  const recipients = env.STAFF_ALERT_ADDRESSES.length ? env.STAFF_ALERT_ADDRESSES : env.STAFF_EMAIL_ALLOWLIST;
  const skip = async (reason: string) => {
    await audit(db, { actor: 'system', action: 'market.stale_alert_skipped', entityKind: 'system', entityId: day, diff: { reason, gaps: gaps.length } });
    return { outcome: 'skipped' as const, gaps: gaps.length, reason };
  };
  if (!recipients.length) return skip('no_staff_addresses');
  if (!provider) return skip('sending_disabled');
  const switches = await loadSwitches(db);
  if (switches.all_outbound === false) return skip('kill_switch_all_outbound');
  if (testModeFrom(switches)) return skip('test_mode');
  const diag = await trackingDiagnosis(db, env, now);
  const causes = likelyCause(diag, gaps, now);
  const hoursSince = (g: MarketGap) => Math.round((now.getTime() - (g.lastCheckAt ?? g.askedAt).getTime()) / 3_600_000);
  const games = gaps.slice(0, 15).map((g) => `${g.name}, ${g.startsAt.toISOString().slice(0, 10)}: ${g.lastCheckAt ? `last checked ${hoursSince(g)}h ago` : `never checked (asked ${hoursSince(g)}h ago)`}${g.tracked ? ` · tracking ${g.tracked.state}${g.tracked.lastError ? ` (${g.tracked.lastError.slice(0, 40)})` : ''}` : ' · not enrolled'}`);
  const link = `${env.APP_URL.replace(/\/$/, '')}/admin/market`;
  const subject = `Market data: ${gaps.length} requested ${gaps.length === 1 ? 'game hasn’t' : 'games haven’t'} had a SeatData check in ${STALE_HOURS}h`;
  const text = [`${gaps.length} ${gaps.length === 1 ? 'game' : 'games'} customers asked about ${gaps.length === 1 ? 'has' : 'have'} had no SeatData check in ${STALE_HOURS} hours, so their replies go out without current prices or a trend.`, `Likely cause:\n${causes.map((c) => `- ${c}`).join('\n')}`, games.join('\n'), `Open the market page: ${link}`, 'This is an automatic alert, sent at most once a day.'].join('\n\n');
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<p>${esc(text.split('\n\n')[0]!)}</p><p><strong>Likely cause</strong></p><ul>${causes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><ul>${games.map((g) => `<li>${esc(g)}</li>`).join('')}</ul><p><a href="${esc(link)}">Open the market page</a></p><p style="color:#666;font-size:12px;">This is an automatic alert, sent at most once a day.</p>`;
  for (const to of recipients) {
    await provider.send({ idempotencyKey: `market-stale:${day}:${to}`, from: `Ticket Guy alerts <${env.CONCIERGE_FROM_ADDRESS}>`, to, subject, text, html, headers: { 'Auto-Submitted': 'auto-generated', 'X-TicketGuy-Staff-Alert': 'true' } });
  }
  await audit(db, { actor: 'system', action: 'market.stale_alert', entityKind: 'system', entityId: day, diff: { gaps: gaps.length, recipients: recipients.length, causes: causes.map((c) => c.slice(0, 120)) } });
  return { outcome: 'sent', gaps: gaps.length };
}

/**
 * A customer's request refused a SeatData read for the day's allowance: one staff email a day, with how the day was
 * spent. Background tracking is capped below the allowance, so this means the whole day is too small for the traffic
 * (raise SEATDATA_DAILY_CALL_LIMIT) rather than tracking crowding a customer out. Recorded either way.
 */
export async function alertBudgetRefusals(db: DbOrTx, env: Env, provider: { send: (a: { idempotencyKey: string; from: string; to: string; subject: string; text: string; html: string; headers: Record<string, string> }) => Promise<unknown> } | null, now: Date): Promise<{ outcome: 'sent' | 'none' | 'skipped'; refused: number; reason?: string }> {
  const day = now.toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00Z`);
  const refusals = await db.select({ eventId: t.marketFetches.eventId, kind: t.marketFetches.kind }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), eq(t.marketFetches.lane, 'customer'), eq(t.marketFetches.status, 'skipped_budget'), gte(t.marketFetches.at, start)));
  if (!refusals.length) return { outcome: 'none', refused: 0 };
  const [already] = await db.select({ id: t.auditLog.id }).from(t.auditLog).where(and(eq(t.auditLog.action, 'market.budget_refused_alert'), eq(t.auditLog.entityId, day))).limit(1);
  if (already) return { outcome: 'skipped', refused: refusals.length, reason: 'already_sent_today' };
  const spent = await db.select({ lane: t.marketFetches.lane, calls: sql<number>`coalesce(sum(${t.marketFetches.calls}), 0)::int` }).from(t.marketFetches).where(and(eq(t.marketFetches.provider, SEATDATA_PROVIDER), gte(t.marketFetches.at, start), notInArray(t.marketFetches.kind, ['history_search', 'history_stats']))).groupBy(t.marketFetches.lane);
  const by = Object.fromEntries(spent.map((r) => [r.lane, Number(r.calls)]));
  const record = (outcome: string, reason?: string) => audit(db, { actor: 'system', action: outcome === 'sent' ? 'market.budget_refused_alert' : 'market.budget_refused_alert_skipped', entityKind: 'system', entityId: day, diff: { refused: refusals.length, customerCalls: by.customer ?? 0, backgroundCalls: by.background ?? 0, limit: env.SEATDATA_DAILY_CALL_LIMIT, ...(reason ? { reason } : {}) } });
  const recipients = env.STAFF_ALERT_ADDRESSES.length ? env.STAFF_ALERT_ADDRESSES : env.STAFF_EMAIL_ALLOWLIST;
  const skip = async (reason: string) => {
    await record('skipped', reason);
    return { outcome: 'skipped' as const, refused: refusals.length, reason };
  };
  if (!recipients.length) return skip('no_staff_addresses');
  if (!provider) return skip('sending_disabled');
  const switches = await loadSwitches(db);
  if (switches.all_outbound === false) return skip('kill_switch_all_outbound');
  if (testModeFrom(switches)) return skip('test_mode');
  const games = new Set(refusals.map((r) => r.eventId).filter(Boolean)).size;
  const subject = `Market data: a customer's request was refused SeatData reads (daily allowance)`;
  const text = [`Today a customer's request was refused ${refusals.length} SeatData ${refusals.length === 1 ? 'read' : 'reads'} (${games} ${games === 1 ? 'game' : 'games'}) because the day's allowance of ${env.SEATDATA_DAILY_CALL_LIMIT} calls is spent: customers' requests ${by.customer ?? 0}, background tracking ${by.background ?? 0} (capped at 60%). Their replies use each game's last listings read, with its age said, where one was kept.`, 'If this repeats, raise SEATDATA_DAILY_CALL_LIMIT (and the SeatData plan with it).', `Open the market page: ${env.APP_URL.replace(/\/$/, '')}/admin/market`, 'This is an automatic alert, sent at most once a day.'].join('\n\n');
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = text.split('\n\n').map((p) => `<p>${esc(p)}</p>`).join('');
  for (const to of recipients) await provider.send({ idempotencyKey: `market-budget:${day}:${to}`, from: `Ticket Guy alerts <${env.CONCIERGE_FROM_ADDRESS}>`, to, subject, text, html, headers: { 'Auto-Submitted': 'auto-generated', 'X-TicketGuy-Staff-Alert': 'true' } });
  await record('sent');
  return { outcome: 'sent', refused: refusals.length };
}
