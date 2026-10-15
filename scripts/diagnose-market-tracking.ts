/**
 * Why SeatData isn't being called (`pnpm tsx scripts/diagnose-market-tracking.ts` in the Render shell). Read-only:
 * no SeatData call, no email, no write. It answers the four usual causes from the database:
 *
 * 1. the scheduler: when the hourly track-markets pass last ran (every pass is recorded since this script's PR;
 *    before that only passes that polled something were, so "none" before the deploy is not proof on its own);
 * 2. the licence: status, approved uses, the "keep data until" date;
 * 3. enrolment: each game an open request asked about, its tracking row, last check and last error;
 * 4. the account: the last authentication, subscription or payment refusal, which stops each pass at its first call.
 *
 * It prints event names and dates, never customer words.
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import { openDatabase } from '../src/lib/db';
import * as t from '../src/lib/db/schema';
import { likelyCause, marketGaps, trackingDiagnosis } from '../src/lib/market/staleness';

const h = await openDatabase();
const now = new Date();
const d = await trackingDiagnosis(h.db, { SEATDATA_API_KEY: process.env.SEATDATA_API_KEY }, now);
console.log(`[market] SEATDATA_API_KEY ${d.apiKey ? 'set' : 'NOT SET'} in this shell`);
console.log(`[market] licence: ${d.licence.status}; uses ${d.licence.uses.join(', ') || 'none'}; tracking ${d.licence.tracking ? 'allowed' : 'NOT allowed'}${d.licence.retentionUntil ? `; keep data until ${d.licence.retentionUntil.toISOString()}` : ''}`);
console.log(`[market] last hourly pass: ${d.lastPass ? `${d.lastPass.at.toISOString()}${d.lastPass.skipped ? ` skipped (${d.lastPass.skipped})` : ''}; due ${d.lastPass.due ?? '?'}, polled ${d.lastPass.polled ?? '?'}${d.lastPass.stoppedBy ? `; stopped by ${d.lastPass.stoppedBy}` : ''}` : 'none recorded'}`);
const passes = await h.db.select({ at: t.auditLog.createdAt }).from(t.auditLog).where(and(eq(t.auditLog.action, 'market.tracking_pass'), gte(t.auditLog.createdAt, new Date(now.getTime() - 7 * 86_400_000)))).orderBy(desc(t.auditLog.createdAt));
console.log(`[market] passes recorded in the last 7 days: ${passes.length}`);
console.log(`[market] last account refusal: ${d.lastAccountError ? `${d.lastAccountError.at.toISOString()} ${d.lastAccountError.detail.slice(0, 80)}` : 'none'}`);
console.log(`[market] SeatData calls by UTC day: ${d.callsLast7Days.map((c) => `${c.day} ${c.calls}`).join(', ') || 'none in 7 days'}`);
const errors = await h.db.select({ at: t.marketFetches.at, kind: t.marketFetches.kind, status: t.marketFetches.status, detail: t.marketFetches.detail }).from(t.marketFetches).where(and(gte(t.marketFetches.at, new Date(now.getTime() - 7 * 86_400_000)))).orderBy(desc(t.marketFetches.at)).limit(15);
for (const e of errors) console.log(`  ${e.at.toISOString()} ${e.kind} ${e.status}${e.detail ? ` ${e.detail.slice(0, 80)}` : ''}`);
const gaps = await marketGaps(h.db, now, 0);
console.log(`[market] games open requests asked about (upcoming): ${gaps.length}`);
for (const g of gaps) console.log(`  ${g.startsAt.toISOString().slice(0, 16)} ${g.name}: last check ${g.lastCheckAt?.toISOString() ?? 'never'}; tracking ${g.tracked ? `${g.tracked.state}, next ${g.tracked.nextPollAt.toISOString()}${g.tracked.lastError ? `, error ${g.tracked.lastError.slice(0, 60)}` : ''}` : 'not enrolled'}`);
const stale = await marketGaps(h.db, now);
console.log(`[market] overdue (no check in 36h): ${stale.length}`);
console.log('[market] likely cause:');
for (const c of likelyCause(d, stale.length ? stale : gaps, now)) console.log(`  - ${c}`);
await h.close();
