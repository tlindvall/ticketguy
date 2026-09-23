import { and, eq, gte, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import { usageLedger } from '@/lib/db/schema';
import { priceFor, type Price } from './prices';

/**
 * Atomic AI budget reservation (A34). Reservations are ledger rows written inside a transaction that
 * first re-reads the current total; concurrent reservations serialize on an advisory lock keyed by request.
 * Amounts are USD micros (1e-6 USD) to keep integer arithmetic.
 */
export const PRICE_TABLE_VERSION = '2026-09-23';
export { PRICES_USD_PER_MTOKEN, CONSERVATIVE_PRICE, parsePriceOverrides, priceFor, type Price } from './prices';

export function estimateUsdMicros(model: string, inputTokens: number, outputTokens: number, extraUsd = 0, overrides: Record<string, Price> = {}): number {
  const p = priceFor(model, overrides);
  const usd = (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output + extraUsd;
  return Math.ceil(usd * 1e6);
}

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(public readonly scope: 'request_hard' | 'global_daily' | 'call_count', public readonly detail: string) {
    super(`AI budget exceeded (${scope}): ${detail}`);
  }
}

export type BudgetLimits = { requestSoftUsd: number; requestHardUsd: number; globalDailyUsd: number; maxCallsPerRevision: number };

export type Reservation = { ledgerId: string; softExceeded: boolean; requestTotalUsdMicros: number };

function hashKey(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

/** Reserve estimated spend BEFORE the call. Throws BudgetExceededError when the hard/global/call limits would be exceeded. */
export async function reserveBudget(db: DbOrTx, args: { requestId: string; revision: number; runId: string | null; jobName: string; model: string; estimatedUsdMicros: number; limits: BudgetLimits; now: Date }): Promise<Reservation> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${hashKey('ai-budget:' + args.requestId)})`);
    const dayStart = new Date(Date.UTC(args.now.getUTCFullYear(), args.now.getUTCMonth(), args.now.getUTCDate()));
    const [req] = await tx
      .select({ total: sql<number>`coalesce(sum(case when kind = 'released' then -estimated_usd_micros else estimated_usd_micros end),0)::bigint`, calls: sql<number>`count(*) filter (where kind = 'reservation')::int` })
      .from(usageLedger)
      .where(and(eq(usageLedger.requestId, args.requestId), eq(usageLedger.revision, args.revision)));
    const [glob] = await tx
      .select({ total: sql<number>`coalesce(sum(case when kind = 'released' then -estimated_usd_micros else estimated_usd_micros end),0)::bigint` })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, dayStart));
    const reqTotal = Number(req?.total ?? 0) + args.estimatedUsdMicros;
    const calls = Number(req?.calls ?? 0) + 1;
    const globTotal = Number(glob?.total ?? 0) + args.estimatedUsdMicros;
    if (calls > args.limits.maxCallsPerRevision) throw new BudgetExceededError('call_count', `${calls} > ${args.limits.maxCallsPerRevision}`);
    if (reqTotal > args.limits.requestHardUsd * 1e6) throw new BudgetExceededError('request_hard', `${(reqTotal / 1e6).toFixed(4)} > ${args.limits.requestHardUsd}`);
    if (globTotal > args.limits.globalDailyUsd * 1e6) throw new BudgetExceededError('global_daily', `${(globTotal / 1e6).toFixed(4)} > ${args.limits.globalDailyUsd}`);
    const [row] = await tx
      .insert(usageLedger)
      .values({ requestId: args.requestId, revision: args.revision, runId: args.runId, jobName: args.jobName, model: args.model, estimatedUsdMicros: args.estimatedUsdMicros, priceTableVersion: PRICE_TABLE_VERSION, kind: 'reservation' })
      .returning({ id: usageLedger.id });
    return { ledgerId: row!.id, softExceeded: reqTotal > args.limits.requestSoftUsd * 1e6, requestTotalUsdMicros: reqTotal };
  });
}

/** Settle with actual usage; the reservation stays (billable retries count) and actuals are recorded alongside. */
export async function settleBudget(db: DbOrTx, ledgerId: string, actual: { inputTokens: number; outputTokens: number; toolCalls: number; actualUsdMicros: number }): Promise<void> {
  await db.update(usageLedger).set({ inputTokens: actual.inputTokens, outputTokens: actual.outputTokens, toolCalls: actual.toolCalls, actualUsdMicros: actual.actualUsdMicros, kind: 'settled' }).where(eq(usageLedger.id, ledgerId));
}

/** Release a reservation whose call never happened (e.g. transport failure before submission). */
export async function releaseBudget(db: DbOrTx, args: { requestId: string; revision: number; model: string; estimatedUsdMicros: number; jobName: string }): Promise<void> {
  await db.insert(usageLedger).values({ requestId: args.requestId, revision: args.revision, jobName: args.jobName, model: args.model, estimatedUsdMicros: args.estimatedUsdMicros, priceTableVersion: PRICE_TABLE_VERSION, kind: 'released' });
}

export async function requestSpendUsd(db: DbOrTx, requestId: string): Promise<number> {
  const [r] = await db.select({ total: sql<number>`coalesce(sum(case when kind = 'released' then -estimated_usd_micros else estimated_usd_micros end),0)::bigint` }).from(usageLedger).where(eq(usageLedger.requestId, requestId));
  return Number(r?.total ?? 0) / 1e6;
}
