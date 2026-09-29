/**
 * Read-only probe of the SeatData API with the configured key (`SEATDATA_API_KEY`), run once in the Render
 * shell: `pnpm tsx scripts/probe-seatdata.ts ["New York Rangers"]`.
 *
 * The client was written from SeatData's official SDK, not from a live response; this confirms the live
 * shapes before tracking is switched on. It prints structure and counts — status codes, key names, how many
 * snapshots and zones, how fresh the newest snapshot is, how often all_in_price is empty per source — never
 * the key, and never listing contents. About 6 API calls.
 */
import { SeatDataClient, SeatDataError } from '../src/lib/market/seatdata';

const key = process.env.SEATDATA_API_KEY;
if (!key) {
  console.error('[probe] SEATDATA_API_KEY is not set in this shell.');
  process.exit(1);
}
const name = process.argv[2] ?? 'New York Rangers';
const api = new SeatDataClient(key, { maxRetries: 1 });
const keys = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o as object).sort().join(', ') : String(o));

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    console.log(`[probe] ${label}: ok`);
    return r;
  } catch (e) {
    console.log(`[probe] ${label}: FAILED ${e instanceof SeatDataError ? `${e.type} ${e.status ?? ''} ${e.message}` : e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const account = await step('account', () => api.account());
if (account) {
  console.log(`  plans: ${(account.plans ?? []).map((p) => `${p.name} (${p.status}${(p as { renews_at?: string }).renews_at ? `, renews ${(p as { renews_at?: string }).renews_at}` : ''})`).join('; ') || 'none'}`);
  for (const [k, v] of Object.entries(account.rate_limits ?? {})) console.log(`  rate limit ${k}: ${v.limit} per ${v.window_seconds}s`);
}
const usage = await step('usage', () => api.usage());
if (usage) console.log(`  period ${usage.period_start} → ${usage.period_end} · used so far: ${Object.entries(usage.totals ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}`);

const search = await step(`search "${name}"`, () => api.searchEvents({ event_name: name, limit: 5 }));
const first = search?.data?.[0];
console.log(`  results: ${search?.data?.length ?? 0} · has_more ${search?.has_more ?? '—'} · item keys: ${keys(first)}`);
console.log(`  Ticketmaster ids present: ${(search?.data ?? []).filter((x) => x.tm_event_id).length} of ${search?.data?.length ?? 0}`);
if (!first) process.exit(0);

const stats = await step(`stats for event ${first.event_id}`, () => api.eventStats(first.event_id, { maxPages: 2 }));
if (stats) {
  const s = stats.snapshots;
  const newest = s.map((x) => new Date(x.timestamp).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const oldest = s.map((x) => new Date(x.timestamp).getTime()).filter(Number.isFinite).sort((a, b) => a - b)[0];
  console.log(`  snapshots: ${s.length}${stats.complete ? '' : '+ (more pages)'} · snapshot keys: ${keys(s[0])}`);
  console.log(`  history: ${oldest && newest ? Math.round((newest - oldest) / 86_400_000) : 0} days · newest is ${newest ? Math.round((Date.now() - newest) / 60_000) : '—'} min old`);
  const gaps = s.map((x) => new Date(x.timestamp).getTime()).sort((a, b) => a - b).map((t, i, a) => (i ? t - a[i - 1]! : 0)).slice(1).sort((a, b) => a - b);
  console.log(`  median gap between snapshots: ${gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]! / 60_000) : '—'} min`);
  const zoneCounts = s.map((x) => x.zones?.length ?? 0);
  console.log(`  zones per snapshot: min ${Math.min(...zoneCounts, 0)} max ${Math.max(...zoneCounts, 0)} · zone keys: ${keys(s.find((x) => x.zones?.length)?.zones?.[0])}`);
  const missing = (f: keyof (typeof s)[number]) => s.filter((x) => x[f] === null || x[f] === undefined).length;
  console.log(`  missing: get_in ${missing('get_in')} · get_in_qty2plus ${missing('get_in_qty2plus')} · total_listings_active ${missing('total_listings_active')} of ${s.length}`);
}

const listings = await step(`listings for event ${first.event_id}`, () => api.listings(first.event_id));
if (listings) {
  const items = Array.isArray(listings.listings) ? listings.listings : [];
  console.log(`  top-level keys: ${keys(listings)} · listings: ${items.length} · listing keys: ${keys(items[0])}`);
}

const sales = await step(`sales for event ${first.event_id}`, () => api.eventSales(first.event_id, { limit: 100 }));
if (sales) {
  const rows = sales.data ?? [];
  const bySource = new Map<string, { n: number; noAllIn: number }>();
  for (const r of rows) {
    const b = bySource.get(r.source) ?? { n: 0, noAllIn: 0 };
    b.n += 1;
    if (r.all_in_price === null || r.all_in_price === undefined) b.noAllIn += 1;
    bySource.set(r.source, b);
  }
  console.log(`  rows: ${rows.length} (total ${sales.total_count ?? '—'}) · row keys: ${keys(rows[0])}`);
  console.log(`  all_in_price empty: ${[...bySource].map(([k, v]) => `${k} ${v.noAllIn}/${v.n}`).join(' · ') || '—'}`);
}
console.log(`[probe] done · ${api.calls} API calls`);
