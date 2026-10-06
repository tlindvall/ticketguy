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
/**
 * TicketData price intelligence (investigational vendor lead, ADVICE_ENGINE §3): get-in prices are
 * all-in, per ticket, with a full history and per-zone series. Kept strictly separate from SeatData's
 * listed-before-fees basis: the two are never compared with each other.
 */
export const TICKETDATA_PROVIDER = 'ticketdata';
/** Fixed id so the licence record survives re-seeding and every row can point at it. */
export const TICKETDATA_DATASET_ID = '5ea7da7a-0000-4000-8000-000000000002';

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

/**
 * `observedAt` is when the provider saw these prices: its snapshot time, or the time it last refreshed the listings.
 * `retrievedAt` is when we fetched them. They are different facts: a cached read fetched again an hour later is the
 * same observation, never a new one. When the provider doesn't say when it saw them, `providerAsOf` is null and
 * `observedAt` falls back to our fetch time, flagged so a trend never reads that time as the market's.
 */
export type SeriesPoint = { basis: MarketBasis; zone: string | null; observedAt: Date; providerAsOf: Date | null; retrievedAt: Date | null; priceCents: number; medianCents: number | null; activeListings: number | null };

/**
 * The provider's own "as of" time from a listings reply (`last_refresh_timestamp`, unix seconds; milliseconds and
 * ISO strings are read too). Missing, unreadable, before 2020 or more than ten minutes after we fetched it: unknown.
 */
export function providerTime(v: unknown, retrievedAt: Date): Date | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : null;
  const d = n !== null ? new Date(n > 1e12 ? n : n * 1000) : typeof v === 'string' && v.trim() ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  if (d.getTime() < Date.UTC(2020, 0, 1) || d.getTime() > retrievedAt.getTime() + 10 * 60_000) return null;
  return d;
}

const cents = (usd: number | null | undefined) => (typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? Math.round(usd * 100) : null);

/** One provider snapshot → one point per basis, overall and per zone. Missing or zero prices are skipped. */
export function pointsFromSnapshot(s: SeatDataStatsSnapshot, retrievedAt: Date | null = null): SeriesPoint[] {
  const at = new Date(s.timestamp);
  if (Number.isNaN(at.getTime())) return [];
  const out: SeriesPoint[] = [];
  const t = { observedAt: at, providerAsOf: at, retrievedAt };
  const active = typeof s.total_listings_active === 'number' ? s.total_listings_active : null;
  const one = cents(s.get_in);
  const two = cents(s.get_in_qty2plus);
  if (one) out.push({ basis: 'single', zone: null, ...t, priceCents: one, medianCents: cents(s.median_price), activeListings: active });
  if (two) out.push({ basis: 'pair', zone: null, ...t, priceCents: two, medianCents: cents(s.median_price), activeListings: active });
  for (const z of s.zones ?? []) {
    const name = z.zone_name?.trim();
    if (!name) continue;
    const z1 = cents(z.get_in);
    const z2 = cents(z.get_in_qty2plus);
    if (z1) out.push({ basis: 'single', zone: name, ...t, priceCents: z1, medianCents: cents(z.median_price), activeListings: null });
    if (z2) out.push({ basis: 'pair', zone: name, ...t, priceCents: z2, medianCents: cents(z.median_price), activeListings: null });
  }
  return out;
}

/**
 * Current listings → one point per group size: the cheapest listed price among active listings with at least
 * that many tickets, their median, and how many there are. The listing shape is undocumented, so every field
 * is read defensively; a listing without a usable price or quantity is left out. No eligible listing, no point.
 */
/**
 * Listings that aren't ordinary seats for an ordinary buyer: wheelchair and companion spaces (they go to people
 * who need them, and are often the cheapest listing), parking and suites. They never set a group's "from" price.
 */
const NOT_ORDINARY_SEATS = /\b(ada|accessible|accessibility|wheelchair|w\/c|companion|parking|lot [a-z0-9]+|suite)\b/i;
export function isOrdinarySeatListing(l: Record<string, unknown>): boolean {
  return ![l.section, l.zone, l.row, l.notes].some((v) => typeof v === 'string' && NOT_ORDINARY_SEATS.test(v));
}

export function pointsFromListings(listings: Array<Record<string, unknown>>, sizes: number[], retrievedAt: Date, providerAsOf: Date | null = null): SeriesPoint[] {
  const rows = listings
    .filter(isOrdinarySeatListing)
    .map((l) => ({ active: l.active === undefined || l.active === null || l.active === true || l.active === 1 || l.active === 'true', price: Number(l.price), qty: Number(l.quantity), zone: typeof l.zone === 'string' && l.zone.trim() ? l.zone.trim() : null }))
    .filter((r) => r.active && Number.isFinite(r.price) && r.price > 0 && Number.isInteger(r.qty) && r.qty > 0);
  const out: SeriesPoint[] = [];
  const t = { observedAt: providerAsOf ?? retrievedAt, providerAsOf, retrievedAt };
  const zones = [...new Set(rows.map((r) => r.zone).filter((z): z is string => !!z))].sort();
  for (const n of [...new Set(sizes.map((q) => Math.min(Math.floor(q), MAX_GROUP_SIZE)))].filter((q) => q >= 3).sort((a, b) => a - b)) {
    // The whole venue, then each zone the listings name, so a floor-only group has a floor-only series.
    for (const zone of [null, ...zones]) {
      const prices = rows.filter((r) => r.qty >= n && (zone === null || r.zone === zone)).map((r) => r.price).sort((a, b) => a - b);
      const cheapest = cents(prices[0]);
      if (!cheapest) continue;
      out.push({ basis: `group:${n}`, zone, ...t, priceCents: cheapest, medianCents: cents(prices[Math.floor(prices.length / 2)]), activeListings: prices.length });
    }
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
/**
 * The newest point must be this fresh to describe the market. SeatData rescans an event about every 8 hours
 * and we check it every 6 to 24, so a 12-hour cut-off called most live series stale; wording says the age
 * whenever the newest point isn't recent (MARKET_RECENT_HOURS).
 */
export const MARKET_STALE_HOURS = 24;
export const MARKET_RECENT_HOURS = 3;
/** Listings are shrinking when the count falls by this share and this many listings over the window. */
export const SUPPLY_DROP_PCT = 0.25;
export const SUPPLY_DROP_MIN = 10;
export const TYPICAL_MIN_EVENTS = 5;

/** `timeKnown: false`: the provider didn't say when it saw this price; it never dates a trend or its freshness. */
export type Point = { observedAt: Date; priceCents: number; activeListings: number | null; timeKnown?: boolean; providerAsOf?: Date | null; retrievedAt?: Date | null };
/** What a trend was read from, for the trace: the newest points used, and reads left out for having no provider time. */
export type MarketObservations = { used: Array<{ observedAt: string; providerAsOf: string | null; retrievedAt: string | null; priceCents: number }>; untimed: number; latestUntimedRetrievedAt: string | null; rule: string | null };
export type Change = { hours: number; fromCents: number; toCents: number; changeCents: number; pct: number } | null;
export type SupplyTrend = 'shrinking' | 'stable' | 'growing' | 'unknown';

export type MarketContext = {
  methodVersion: string;
  basis: MarketBasis;
  zone: string | null;
  adequacy: 'sufficient' | 'insufficient';
  reasons: string[];
  /** `timeKnown: false`: the newest read had no provider time; `at` is when we fetched it, not when the market was seen. */
  current: { priceCents: number; at: Date; activeListings: number | null; timeKnown?: boolean } | null;
  h24: Change;
  h72: Change;
  /** `mixed`: the day and the three days moved in different directions; neither a fall to wait on nor a steady price. */
  direction: 'down' | 'up' | 'flat' | 'mixed' | 'insufficient';
  supply: { trend: SupplyTrend; now: number | null; before: number | null; hours: number | null };
  typical: { events: number; p25Cents: number; medianCents: number; p75Cents: number; leadBucket: string } | null;
  points: number;
  observations?: MarketObservations;
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

/**
 * How old a listings read is by the provider's clock (LAUNCH-06): "undated" when the provider gave no refresh time,
 * "recent" under two hours, otherwise whole hours. Our fetch time never makes a read look new.
 */
export function listingAge(providerAsOf: Date | null, now: Date): 'undated' | 'recent' | number {
  if (!providerAsOf) return 'undated';
  const ms = now.getTime() - providerAsOf.getTime();
  return ms < 2 * 3_600_000 ? 'recent' : Math.round(ms / 3_600_000);
}

/** A window's change counts as a move: both the share and the cents. */
export const marketMoved = (c: Change) => !!c && Math.abs(c.pct) >= MARKET_MOVE_PCT && Math.abs(c.changeCents) >= MARKET_MOVE_CENTS;
const moved = marketMoved;

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
  const all = a.points.filter((p) => p.observedAt <= a.now).sort((x, y) => x.observedAt.getTime() - y.observedAt.getTime());
  // Only points the provider dated make a series: a read without its time could be hours old, or the same cached
  // listings fetched again, and counting it would invent both history and freshness.
  const pts = all.filter((p) => p.timeKnown !== false);
  const untimed = all.filter((p) => p.timeKnown === false);
  const reasons: string[] = [];
  const current = pts[pts.length - 1];
  const lastUntimed = untimed[untimed.length - 1];
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const observations: MarketObservations = { used: pts.slice(-24).map((p) => ({ observedAt: p.observedAt.toISOString(), providerAsOf: iso(p.providerAsOf === undefined ? p.observedAt : p.providerAsOf), retrievedAt: iso(p.retrievedAt), priceCents: p.priceCents })), untimed: untimed.length, latestUntimedRetrievedAt: iso(lastUntimed?.retrievedAt ?? lastUntimed?.observedAt), rule: null };
  const base: MarketContext = { methodVersion: MARKET_METHOD_VERSION, basis: a.basis, zone: a.zone, adequacy: 'insufficient', reasons, current: current ? { priceCents: current.priceCents, at: current.observedAt, activeListings: current.activeListings, timeKnown: true } : null, h24: null, h72: null, direction: 'insufficient', supply: { trend: 'unknown', now: null, before: null, hours: null }, typical: null, points: pts.length, observations };
  const lead = Math.round((a.eventStartAt.getTime() - a.now.getTime()) / 60_000);
  base.typical = a.comparables?.length ? typicalAtLead(a.comparables, lead) : null;
  if (!current) {
    if (lastUntimed) {
      // The price is real, its age isn't known: said as "when I checked", never as a trend or as current.
      reasons.push('provider_time_unknown');
      base.current = { priceCents: lastUntimed.priceCents, at: lastUntimed.observedAt, activeListings: lastUntimed.activeListings, timeKnown: false };
    } else reasons.push('no_points');
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

  // No 24- or 72-hour baseline is no comparison at all: it never reads as prices holding steady (post-deploy QA Oct 2,
  // TREND-2327-01: four reads over 12 hours falling 30% came back "sufficient, flat").
  const w = base.h72 ?? base.h24;
  if (!w) {
    reasons.push('no_comparison_window');
    return base;
  }
  base.adequacy = 'sufficient';
  const dir = (c: NonNullable<Change>) => (c.changeCents < 0 ? 'down' : 'up') as 'down' | 'up';
  const long = base.h72;
  const short = base.h24;
  // The day and the three days must agree for a direction. A dip after days of rises, or a jump that undoes a fall,
  // is "mixed": it is neither a fall worth waiting on nor a steady price (it used to read "flat").
  if (long && short) {
    const lm = moved(long);
    const sm = moved(short);
    if (lm && sm) base.direction = dir(long) === dir(short) ? dir(long) : 'mixed';
    else if (sm) base.direction = 'mixed';
    else base.direction = lm ? dir(long) : 'flat';
    observations.rule = `h72_${lm ? dir(long) : 'held'}_h24_${sm ? dir(short) : 'held'}`;
  } else {
    base.direction = moved(w) ? dir(w) : 'flat';
    observations.rule = `h${w.hours}_${moved(w) ? dir(w) : 'held'}_only`;
  }
  return base;
}
