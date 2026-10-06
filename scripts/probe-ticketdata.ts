/**
 * Read-only probe of the TicketData public API (no key), run from a shell with network access:
 * `pnpm tsx scripts/probe-ticketdata.ts ["Metallica"]`.
 *
 * The client was written from the CLI's public spec.yaml (data.ticketdata.com/api), not from a live
 * reply; this confirms the live shapes before any sync is switched on. It prints structure and counts —
 * status codes, key names, how many history points and zones, how fresh the newest point is — never full
 * payloads. About 4 API calls. INVESTIGATIONAL: confirming the shape is not licence clearance
 * (ADVICE_ENGINE §3); request dataset documentation and licence terms before relying on it.
 */
import { TicketDataClient, TicketDataError } from '../src/lib/market/ticketdata';

const base = process.env.TICKETDATA_BASE_URL;
const name = process.argv[2] ?? 'Metallica';
const api = new TicketDataClient({ baseUrl: base, maxRetries: 1 });
const keys = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o as object).sort().join(', ') : String(o));

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    console.log(`[probe] ${label}: ok`);
    return r;
  } catch (e) {
    console.log(`[probe] ${label}: FAILED ${e instanceof TicketDataError ? `${e.type} ${e.status ?? ''} ${e.message}` : e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const suggestions = await step(`suggestions "${name}"`, () => api.searchSuggestions(name));
const first = suggestions?.[0];
console.log(`  results: ${suggestions?.length ?? 0} · item keys: ${keys(first)}`);
if (!first) process.exit(0);

const detail = await step(`event ${first.id}`, () => api.getEvent(first.id));
if (detail) {
  console.log(`  detail keys: ${keys(detail)}`);
  console.log(`  get-in: ${detail.getInPriceCents === null ? 'null' : `$${(detail.getInPriceCents / 100).toFixed(2)}`} · forecast ${detail.forecastDirection ?? 'null'} · changes 3d/7d/14d/30d: ${[detail.change3d, detail.change7d, detail.change14d, detail.change30d].map((c) => (c === null ? 'null' : `${(c * 100).toFixed(1)}%`)).join(' / ')}`);
  console.log(`  marketplace links: ${detail.marketplaceLinks.length}`);
}

const history = await step(`price-history ${first.id}`, () => api.getPriceHistory(first.id));
if (history) {
  const pts = history.points;
  const times = pts.map((p) => p.observedAt.getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  const newest = times[times.length - 1];
  const oldest = times[0];
  console.log(`  points: ${pts.length} · zones: ${history.zones.length} · history span: ${oldest && newest ? Math.round((newest - oldest) / 86_400_000) : 0} days · newest is ${newest ? Math.round((Date.now() - newest) / 60_000) : '—'} min old`);
  const gaps = times.map((t, i, a) => (i ? t - a[i - 1]! : 0)).slice(1).sort((a, b) => a - b);
  console.log(`  median gap between points: ${gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]! / 60_000) : '—'} min`);
  console.log(`  null get-in: ${pts.filter((p) => p.getInCents === null).length} of ${pts.length} · on-sale ${history.onSaleAt ?? 'null'} · presale ${history.presaleAt ?? 'null'}`);
  const zoneSizes = history.zones.map((z) => `${z.zone}:${z.points.length}`).slice(0, 8).join(' ');
  console.log(`  zone series: ${zoneSizes || '—'}`);
}

const sections = await step(`sections ${first.id}`, () => api.getSections(first.id));
if (sections) console.log(`  sections: ${sections.length} · sample: ${sections.slice(0, 6).join(', ')}`);
console.log(`[probe] done · ${api.calls} API calls`);
