import { eq } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import type { Env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { TicketmasterDiscoveryAdapter } from '@/lib/sources/adapters';
import { DISCOVERY_SOURCE_ID, syncFromDiscovery, type SyncOutcome } from './sync';
import { toIsoDate } from '@/lib/domain/dates';

/**
 * Refreshes the catalog for the configured pilot names. It runs on a schedule and is the reason a request
 * for "the Rangers" resolves from rows that already exist instead of a provider call at the moment a
 * customer is waiting. It honours the same enablement rule as request-time discovery: key AND an enabled,
 * approved adapter row, or it does nothing and says so.
 */
export async function prewarmCatalog(db: DbOrTx, env: Env, opts: { now?: Date; fetchImpl?: typeof fetch; horizonDays?: number } = {}): Promise<{ ran: boolean; reason?: string; results: Array<{ keyword: string } & SyncOutcome> }> {
  const now = opts.now ?? new Date();
  if (!env.TICKETMASTER_DISCOVERY_ENABLED || !env.TICKETMASTER_DISCOVERY_API_KEY) return { ran: false, reason: 'discovery_not_configured', results: [] };
  const [cfg] = await db.select().from(t.adapterConfigs).where(eq(t.adapterConfigs.sourceId, DISCOVERY_SOURCE_ID));
  if (!cfg?.enabled || cfg.implementation !== 'ticketmaster_discovery') return { ran: false, reason: 'adapter_not_enabled', results: [] };
  if (env.CATALOG_SEED_KEYWORDS.length === 0) return { ran: false, reason: 'no_seed_keywords', results: [] };

  const adapter = new TicketmasterDiscoveryAdapter(env.TICKETMASTER_DISCOVERY_API_KEY, true, opts.fetchImpl ?? fetch);
  const horizon = opts.horizonDays ?? 120;
  const start = `${toIsoDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate())}T00:00:00Z`;
  const endDate = new Date(now.getTime() + horizon * 86_400_000);
  const end = `${toIsoDate(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate())}T23:59:59Z`;

  const results: Array<{ keyword: string } & SyncOutcome> = [];
  for (const keyword of env.CATALOG_SEED_KEYWORDS) {
    // Larger page than a request-time lookup: a season is more than 20 games.
    const r = await syncFromDiscovery(db, adapter, { keyword, startDateTime: start, endDateTime: end, size: 100, trigger: 'prewarm', dailyCallLimit: cfg.dailyCallLimit, now });
    results.push({ keyword, ...r });
    if (r.status === 'skipped_budget' || r.status === 'rate_limited') break; // do not spend the rest of the quota on a bad day
  }
  return { ran: true, results };
}
