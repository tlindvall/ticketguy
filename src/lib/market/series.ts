import { createHash } from 'node:crypto';
import type { SeatDataStatsSnapshot } from './seatdata';

/**
 * Resale market series (DECISION_LOG #44). SeatData reports, per snapshot, the cheapest listed price for any
 * quantity (`get_in`) and for listings of two or more (`get_in_qty2plus`), overall and per seating zone,
 * plus how many listings are active. These are LISTED prices before fees, per ticket: never a checkout
 * total, never an offer, and never compared with an all-in price.
 *
 * Group sizes: a single ticket reads the any-quantity series, a pair the two-or-more series. Three or more
 * read a series we build ourselves from SeatData's current listings (DECISION_LOG #45): at each check, the
 * cheapest listing that has at least that many tickets, and how many listings do. A listing of six may not
 * sell exactly five (sellers set split rules), so it is "listed with 5 or more", never "5 together".
 */
export const MARKET_METHOD_VERSION = 'market-1.0';
export const SEATDATA_PROVIDER = 'seatdata';
/** Fixed id so the licence record survives re-seeding and every row can point at it. */
export const SEATDATA_DATASET_ID = '5ea7da7a-0000-4000-8000-000000000001';

export type MarketBasis = 'single' | 'pair' | `group:${number}`;

/** Groups larger than this read the largest size's series: listings that big are rare and the count says so. */
export const MAX_GROUP_SIZE = 12;

export function basisForQuantity(quantity: number): MarketBasis {
  if (quantity <= 1) return 'single';
  if (quantity === 2) return 'pair';
  return `group:${Math.min(Math.floor(quantity), MAX_GROUP_SIZE)}`;
}

/** How many tickets a basis is about: 1, 2, or the group's size. */
export function basisSize(basis: MarketBasis): number {
  return basis === 'single' ? 1 : basis === 'pair' ? 2 : Number(basis.slice(6));
}

export const isGroupBasis = (basis: MarketBasis | null): basis is `group:${number}` => !!basis && basis.startsWith('group:');

export function marketBasketKey(eventKey: string, basis: MarketBasis, zone: string | null): string {
  return createHash('sha256').update(`${eventKey}|market|${basis}|zone=${zone ?? 'any'}|listed`).digest('hex').slice(0, 24);
}

export type SeriesPoint = { basis: MarketBasis; zone: string | null; observedAt: Date; priceCents: number; medianCents: number | null; activeListings: number | null };

const cents = (usd: number | null | undefined) => (typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? Math.round(usd * 100) : null);

/** One provider snapshot → one point per basis, overall and per zone. Missing or zero prices are skipped. */
export function pointsFromSnapshot(s: SeatDataStatsSnapshot): SeriesPoint[] {
  const at = new Date(s.timestamp);
  if (Number.isNaN(at.getTime())) return [];
  const out: SeriesPoint[] = [];
  const active = typeof s.total_listings_active === 'number' ? s.total_listings_active : null;
  const one = cents(s.get_in);
  const two = cents(s.get_in_qty2plus);
  if (one) out.push({ basis: 'single', zone: null, observedAt: at, priceCents: one, medianCents: cents(s.median_price), activeListings: active });
  if (two) out.push({ basis: 'pair', zone: null, observedAt: at, priceCents: two, medianCents: cents(s.median_price), activeListings: active });
  for (const z of s.zones ?? []) {
    const name = z.zone_name?.trim();
    if (!name) continue;
    const z1 = cents(z.get_in);
    const z2 = cents(z.get_in_qty2plus);
    if (z1) out.push({ basis: 'single', zone: name, observedAt: at, priceCents: z1, medianCents: cents(z.median_price), activeListings: null });
    if (z2) out.push({ basis: 'pair', zone: name, observedAt: at, priceCents: z2, medianCents: cents(z.median_price), activeListings: null });
  }
  return out;
}

/**
 * Current listings → one point per group size: the cheapest listed price among active listings with at least
 * that many tickets, their median, and how many there are. The listing shape is undocumented, so every field
 * is read defensively; a listing without a usable price or quantity is left out. No eligible listing, no point.
 */
export function pointsFromListings(listings: Array<Record<string, unknown>>, sizes: number[], at: Date): SeriesPoint[] {
  const rows = listings
    .map((l) => ({ active: l.active === undefined || l.active === null || l.active === true || l.active === 1 || l.active === 'true', price: Number(l.price), qty: Number(l.quantity) }))
    .filter((r) => r.active && Number.isFinite(r.price) && r.price > 0 && Number.isInteger(r.qty) && r.qty > 0);
  const out: SeriesPoint[] = [];
  for (const n of [...new Set(sizes.map((q) => Math.min(Math.floor(q), MAX_GROUP_SIZE)))].filter((q) => q >= 3).sort((a, b) => a - b)) {
    const prices = rows.filter((r) => r.qty >= n).map((r) => r.price).sort((a, b) => a - b);
    const cheapest = cents(prices[0]);
    if (!cheapest) continue;
    out.push({ basis: `group:${n}`, zone: null, observedAt: at, priceCents: cheapest, medianCents: cents(prices[Math.floor(prices.length / 2)]), activeListings: prices.length });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Market context: what the series says now. Pure; every number a customer might see is computed here.
// ---------------------------------------------------------------------------------------------------------

export const MARKET_MIN_POINTS = 4;
export const MARKET_MIN_SPAN_HOURS = 12;
/** A move counts when it is both this share and this many cents per ticket. */
export const MARKET_MOVE_PCT = 0.05;
export const MARKET_MOVE_CENTS = 300;
/** The newest point must be this fresh to describe the market "now". */
export const MARKET_STALE_HOURS = 12;
/** Listings are shrinking when the count falls by this share and this many listings over the window. */
export const SUPPLY_DROP_PCT = 0.25;
export const SUPPLY_DROP_MIN = 10;
export const TYPICAL_MIN_EVENTS = 5;

export type Point = { observedAt: Date; priceCents: number; activeListings: number | null };
export type Change = { hours: number; fromCents: number; toCents: number; changeCents: number; pct: number } | null;
export type SupplyTrend = 'shrinking' | 'stable' | 'growing' | 'unknown';

export type MarketContext = {
  methodVersion: string;
  basis: MarketBasis;
  zone: string | null;
  adequacy: 'sufficient' | 'insufficient';
  reasons: string[];
  current: { priceCents: number; at: Date; activeListings: number | null } | null;
  h24: Change;
  h72: Change;
  direction: 'down' | 'up' | 'flat' | 'insufficient';
  supply: { trend: SupplyTrend; now: number | null; before: number | null; hours: number | null };
  typical: { events: number; p25Cents: number; medianCents: number; p75Cents: number; leadBucket: string } | null;
  points: number;
};

function nearest(points: Point[], target: number, toleranceMs: number): Point | undefined {
  let best: Point | undefined;
  for (const p of points) {
    const d = Math.abs(p.observedAt.getTime() - target);
    if (d <= toleranceMs && (!best || d < Math.abs(best.observedAt.getTime() - target))) best = p;
  }
  return best;
}

function change(points: Point[], current: Point, hours: number): Change {
  const base = nearest(points.filter((p) => p !== current), current.observedAt.getTime() - hours * 3_600_000, Math.max(3, hours / 4) * 3_600_000);
  if (!base) return null;
  return { hours, fromCents: base.priceCents, toCents: current.priceCents, changeCents: current.priceCents - base.priceCents, pct: (current.priceCents - base.priceCents) / base.priceCents };
}

const moved = (c: Change) => !!c && Math.abs(c.pct) >= MARKET_MOVE_PCT && Math.abs(c.changeCents) >= MARKET_MOVE_CENTS;

export function leadBucketFor(leadMinutes: number): string {
  const h = leadMinutes / 60;
  if (h < 24) return '0-1d';
  if (h < 72) return '1-3d';
  if (h < 168) return '3-7d';
  if (h < 336) return '7-14d';
  if (h < 720) return '14-30d';
  return '30d+';
}

function quantile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return sorted[lo]! + (h - lo) * ((sorted[Math.min(lo + 1, sorted.length - 1)] ?? sorted[lo]!) - sorted[lo]!);
}

/**
 * The typical cheapest listed price at this lead time for past comparable events: one value per event (its
 * point nearest the same lead time, within the same bucket), so a heavily sampled game counts once.
 */
export function typicalAtLead(comparables: Array<{ eventKey: string; leadMinutes: number; priceCents: number }>, leadMinutes: number): MarketContext['typical'] {
  const bucket = leadBucketFor(leadMinutes);
  const perEvent = new Map<string, { d: number; price: number }>();
  for (const c of comparables) {
    if (leadBucketFor(c.leadMinutes) !== bucket) continue;
    const d = Math.abs(c.leadMinutes - leadMinutes);
    const prev = perEvent.get(c.eventKey);
    if (!prev || d < prev.d) perEvent.set(c.eventKey, { d, price: c.priceCents });
  }
  if (perEvent.size < TYPICAL_MIN_EVENTS) return null;
  const v = [...perEvent.values()].map((x) => x.price).sort((a, b) => a - b);
  return { events: v.length, p25Cents: Math.round(quantile(v, 0.25)), medianCents: Math.round(quantile(v, 0.5)), p75Cents: Math.round(quantile(v, 0.75)), leadBucket: bucket };
}

export function computeMarketContext(a: { basis: MarketBasis; zone: string | null; points: Point[]; now: Date; eventStartAt: Date; comparables?: Array<{ eventKey: string; leadMinutes: number; priceCents: number }> }): MarketContext {
  const pts = a.points.filter((p) => p.observedAt <= a.now).sort((x, y) => x.observedAt.getTime() - y.observedAt.getTime());
  const reasons: string[] = [];
  const current = pts[pts.length - 1];
  const base: MarketContext = { methodVersion: MARKET_METHOD_VERSION, basis: a.basis, zone: a.zone, adequacy: 'insufficient', reasons, current: current ? { priceCents: current.priceCents, at: current.observedAt, activeListings: current.activeListings } : null, h24: null, h72: null, direction: 'insufficient', supply: { trend: 'unknown', now: null, before: null, hours: null }, typical: null, points: pts.length };
  const lead = Math.round((a.eventStartAt.getTime() - a.now.getTime()) / 60_000);
  base.typical = a.comparables?.length ? typicalAtLead(a.comparables, lead) : null;
  if (!current) {
    reasons.push('no_points');
    return base;
  }
  const staleHours = (a.now.getTime() - current.observedAt.getTime()) / 3_600_000;
  const spanHours = (current.observedAt.getTime() - pts[0]!.observedAt.getTime()) / 3_600_000;
  base.h24 = change(pts, current, 24);
  base.h72 = change(pts, current, 72);

  // Supply: the listing count now against the oldest count within three days.
  const withCount = pts.filter((p) => p.activeListings !== null);
  const nowCount = withCount[withCount.length - 1];
  const before = nowCount ? withCount.find((p) => nowCount.observedAt.getTime() - p.observedAt.getTime() <= 72 * 3_600_000 && nowCount.observedAt.getTime() - p.observedAt.getTime() >= 12 * 3_600_000) : undefined;
  if (nowCount && before && nowCount.observedAt.getTime() - (a.now.getTime() - MARKET_STALE_HOURS * 3_600_000) >= 0) {
    const n = nowCount.activeListings!;
    const b = before.activeListings!;
    const drop = b - n;
    const trend: SupplyTrend = drop >= SUPPLY_DROP_MIN && drop / Math.max(b, 1) >= SUPPLY_DROP_PCT ? 'shrinking' : -drop >= SUPPLY_DROP_MIN && -drop / Math.max(b, 1) >= SUPPLY_DROP_PCT ? 'growing' : 'stable';
    base.supply = { trend, now: n, before: b, hours: Math.round((nowCount.observedAt.getTime() - before.observedAt.getTime()) / 3_600_000) };
  }

  if (staleHours > MARKET_STALE_HOURS) reasons.push(`stale:${Math.round(staleHours)}h`);
  if (pts.length < MARKET_MIN_POINTS) reasons.push(`fewer_than_${MARKET_MIN_POINTS}_points:${pts.length}`);
  if (spanHours < MARKET_MIN_SPAN_HOURS) reasons.push(`span_under_${MARKET_MIN_SPAN_HOURS}h`);
  if (reasons.length) return base;

  base.adequacy = 'sufficient';
  // Direction needs the window move and the longer view not to disagree: a dip after a week of rises is "mixed" → flat.
  const w = base.h72 ?? base.h24;
  if (!w) base.direction = 'flat';
  else if (moved(w)) {
    const other = w === base.h72 ? base.h24 : null;
    base.direction = other && moved(other) && Math.sign(other.changeCents) !== Math.sign(w.changeCents) ? 'flat' : w.changeCents < 0 ? 'down' : 'up';
  } else base.direction = 'flat';
  return base;
}
