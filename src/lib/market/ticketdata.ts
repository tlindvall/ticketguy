/**
 * TicketData price-intelligence client (https://www.ticketdata.com).
 *
 * INVESTIGATIONAL — vendor lead, not an approved integration (ADVICE_ENGINE §3). TicketData is a price
 * tracker, not a marketplace: it reports an event's get-in price (the lowest all-in resale price across
 * marketplaces), its full price history, a forecast and N-day changes. Nothing it returns is ever a
 * purchasable offer. Do not claim commercial rights: request concrete dataset documentation and licence
 * terms before relying on it in production.
 *
 * API surface follows the public spec of the ticketdata CLI
 * (printing-press-library/library/media-and-entertainment/ticketdata/spec.yaml): base
 * https://data.ticketdata.com/api, no auth, Chrome-compatible transport. Endpoint shapes were read from
 * that spec, not from a live reply, so every field is parsed defensively and anything unrecognised
 * becomes null rather than a throw.
 */

export const TICKETDATA_BASE_URL = 'https://data.ticketdata.com/api';

/** Get-in prices are all-in (fees included), per ticket. Never a checkout total, never an offer. */
export type TicketDataEventDetail = {
  id: string;
  name: string;
  getInPriceCents: number | null;
  forecastDirection: 'up' | 'down' | 'flat' | null;
  forecastValueCents: number | null;
  /** Fractional N-day change of the get-in price, e.g. -0.05. Null when the window has no baseline. */
  change3d: number | null;
  change7d: number | null;
  change14d: number | null;
  change30d: number | null;
  marketplaceLinks: Array<{ label: string; url: string }>;
  performerName: string | null;
  venueName: string | null;
  venueCity: string | null;
  startAt: string | null;
};

export type TicketDataHistoryPoint = {
  observedAt: Date;
  getInCents: number | null;
  activeListings: number | null;
};

export type TicketDataZoneHistory = {
  zone: string;
  points: TicketDataHistoryPoint[];
};

export type TicketDataHistory = {
  points: TicketDataHistoryPoint[];
  zones: TicketDataZoneHistory[];
  onSaleAt: string | null;
  presaleAt: string | null;
};

export type TicketDataSuggestion = {
  kind: 'event' | 'performer' | 'venue' | string;
  id: string;
  name: string;
  detail: string | null;
};

export type TicketDataErrorType = 'not_found' | 'rate_limit_error' | 'invalid_request' | 'server_error' | 'network_error' | 'budget_exhausted' | 'schema_drift';

export class TicketDataError extends Error {
  constructor(
    readonly type: TicketDataErrorType,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

/** Dollars (number or numeric string) → integer cents. Null unless it is a sane positive amount. */
export function dollarsToCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[$,]/g, '')) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return Math.round(n * 100);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const frac = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) < 10 ? n : null;
};

function directionOf(v: unknown): TicketDataEventDetail['forecastDirection'] {
  const s = str(v)?.toLowerCase();
  return s === 'up' || s === 'down' || s === 'flat' ? s : null;
}

function linksOf(v: unknown): Array<{ label: string; url: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ label: string; url: string }> = [];
  for (const e of v.slice(0, 20)) {
    const r = e as Record<string, unknown>;
    const url = str(r.url);
    if (url && /^https:\/\/[^\s]+$/.test(url)) out.push({ label: str(r.label) ?? str(r.name) ?? 'tickets', url });
  }
  return out;
}

function pointOf(p: unknown): TicketDataHistoryPoint | null {
  const r = (p ?? {}) as Record<string, unknown>;
  const t = r.timestamp ?? r.observed_at ?? r.date ?? r.time;
  const d = typeof t === 'number' ? new Date(t > 1e12 ? t : t * 1000) : typeof t === 'string' && t ? new Date(t) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const n = r.active_listings ?? r.listings ?? r.listing_count;
  return { observedAt: d, getInCents: dollarsToCents(r.get_in ?? r.getIn ?? r.get_in_price ?? r.price), activeListings: typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null };
}

/** The spec wraps payloads in `{ data: … }`; accept a bare payload too, so a shape change degrades gracefully. */
function dataOf<T>(json: unknown): T | null {
  if (json && typeof json === 'object') {
    const r = json as Record<string, unknown>;
    if ('data' in r) return r.data as T;
    return json as T;
  }
  return null;
}

export class TicketDataClient {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Every HTTP call made, for the daily budget and the usage log. */
  calls = 0;
  /**
   * No attempt, retries included, is made once `calls` reaches this: the caller sets it from the day's
   * remaining allowance. Null means uncapped (probes and scripts).
   */
  callCap: number | null = null;

  constructor(opts: { fetchImpl?: typeof fetch; baseUrl?: string; maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = (opts.baseUrl ?? TICKETDATA_BASE_URL).replace(/\/$/, '');
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request<T>(path: string, q: Record<string, string | number | boolean | null | undefined> = {}, retrySafe = true): Promise<T | null> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      if (this.callCap !== null && this.calls >= this.callCap) throw new TicketDataError('budget_exhausted', null, 'daily call allowance reached');
      this.calls += 1;
      try {
        // Chrome-compatible transport for the browser-facing endpoints: no auth, browser headers.
        res = await this.fetchImpl(url.toString(), { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        if (retrySafe && attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new TicketDataError('network_error', null, e instanceof Error ? e.name : 'network error');
      }
      if (res.ok) {
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          throw new TicketDataError('schema_drift', res.status, 'response was not JSON');
        }
        return dataOf<T>(json);
      }
      if (retrySafe && RETRY_STATUS.has(res.status) && attempt < this.maxRetries) {
        const after = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (res.status === 404) return null;
      throw new TicketDataError(res.status === 429 ? 'rate_limit_error' : res.status === 400 ? 'invalid_request' : 'server_error', res.status, `HTTP ${res.status}`);
    }
  }

  /** Resolve a performer, venue or event name to TicketData's canonical record. */
  async searchSuggestions(q: string): Promise<TicketDataSuggestion[]> {
    const json = await this.request<Record<string, unknown>>('/autocomplete/suggestions', { q });
    const list = Array.isArray(json) ? json : Array.isArray((json as Record<string, unknown> | null)?.suggestions) ? (json as { suggestions: unknown[] }).suggestions : [];
    return (list as unknown[])
      .map((e) => {
        const r = (e ?? {}) as Record<string, unknown>;
        const id = str(r.id ?? r.event_id ?? r.slug);
        const name = str(r.name ?? r.title);
        if (!id || !name) return null;
        return { kind: str(r.kind ?? r.type) ?? 'unknown', id, name, detail: str(r.detail ?? r.subtitle) };
      })
      .filter((s): s is TicketDataSuggestion => s !== null)
      .slice(0, 20);
  }

  /** Current get-in price, forecast, N-day changes and marketplace links for one event. */
  async getEvent(id: string | number): Promise<TicketDataEventDetail | null> {
    const d = await this.request<Record<string, unknown>>(`/events/${encodeURIComponent(String(id))}`);
    if (!d) return null;
    const changes = (d.changes ?? d.price_changes ?? {}) as Record<string, unknown>;
    return {
      id: String(id),
      name: str(d.name ?? d.title) ?? `event ${id}`,
      getInPriceCents: dollarsToCents(d.get_in ?? d.getIn ?? d.get_in_price),
      forecastDirection: directionOf((d.forecast as Record<string, unknown> | undefined)?.direction ?? d.forecast_direction),
      forecastValueCents: dollarsToCents((d.forecast as Record<string, unknown> | undefined)?.value ?? d.forecast_value),
      change3d: frac(changes['3d'] ?? changes.d3 ?? d.change_3d),
      change7d: frac(changes['7d'] ?? changes.d7 ?? d.change_7d),
      change14d: frac(changes['14d'] ?? changes.d14 ?? d.change_14d),
      change30d: frac(changes['30d'] ?? changes.d30 ?? d.change_30d),
      marketplaceLinks: linksOf(d.marketplace_links ?? d.links ?? d.tickets),
      performerName: str((d.performer as Record<string, unknown> | undefined)?.name ?? d.performer_name),
      venueName: str((d.venue as Record<string, unknown> | undefined)?.name ?? d.venue_name),
      venueCity: str((d.venue as Record<string, unknown> | undefined)?.city ?? d.venue_city),
      startAt: str(d.start_at ?? d.event_date ?? d.date),
    };
  }

  /** Full get-in price time series plus per-zone series and on/presale dates. */
  async getPriceHistory(id: string | number): Promise<TicketDataHistory> {
    const empty: TicketDataHistory = { points: [], zones: [], onSaleAt: null, presaleAt: null };
    const d = await this.request<Record<string, unknown>>(`/events/${encodeURIComponent(String(id))}/price-history`);
    if (!d) return empty;
    const rawPoints = Array.isArray(d.points) ? d.points : Array.isArray(d.history) ? d.history : Array.isArray(d.series) ? d.series : [];
    const points = (rawPoints as unknown[]).map(pointOf).filter((p): p is TicketDataHistoryPoint => p !== null);
    const rawZones = Array.isArray(d.zones) ? d.zones : [];
    const zones: TicketDataZoneHistory[] = [];
    for (const z of rawZones as unknown[]) {
      const r = (z ?? {}) as Record<string, unknown>;
      const zone = str(r.zone ?? r.zone_name ?? r.name);
      if (!zone) continue;
      const zp = (Array.isArray(r.points) ? r.points : Array.isArray(r.history) ? r.history : []) as unknown[];
      zones.push({ zone, points: zp.map(pointOf).filter((p): p is TicketDataHistoryPoint => p !== null) });
    }
    return { points, zones: zones.slice(0, 50), onSaleAt: str(d.on_sale_at ?? d.onsale_at), presaleAt: str(d.presale_at) };
  }

  /** Section names catalogued for an event. */
  async getSections(id: string | number): Promise<string[]> {
    const d = await this.request<Record<string, unknown>>(`/events/${encodeURIComponent(String(id))}/zones/sections`);
    const list = Array.isArray(d) ? d : Array.isArray((d as Record<string, unknown> | null)?.sections) ? (d as { sections: unknown[] }).sections : [];
    return (list as unknown[]).map((s) => str((s as Record<string, unknown>)?.name ?? s)).filter((s): s is string => !!s);
  }
}

/**
 * Fixture client: deterministic synthetic price series, no network. Every value is clearly synthetic;
 * rows written from it carry isFixture like every other fixture path, which the send gate rejects.
 */
export class TicketDataFixtureClient {
  calls = 0;
  callCap: number | null = null;
  constructor(private readonly seed = 7) {}

  private series(days: number, baseCents: number, driftPerDay: number): TicketDataHistoryPoint[] {
    const out: TicketDataHistoryPoint[] = [];
    const now = Date.now();
    let s = this.seed;
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    for (let d = days; d >= 0; d--) {
      const noise = (rnd() - 0.5) * baseCents * 0.08;
      out.push({ observedAt: new Date(now - d * 86_400_000), getInCents: Math.max(1000, Math.round(baseCents + driftPerDay * (days - d) + noise)), activeListings: 40 + Math.round(rnd() * 60) });
    }
    return out;
  }

  async searchSuggestions(q: string): Promise<TicketDataSuggestion[]> {
    this.calls += 1;
    return [{ kind: 'event', id: 'fx-1', name: `Fixture event matching "${q}"`, detail: 'synthetic' }];
  }

  async getEvent(id: string | number): Promise<TicketDataEventDetail> {
    this.calls += 1;
    return { id: String(id), name: 'Fixture Event', getInPriceCents: 8500, forecastDirection: 'down', forecastValueCents: 7900, change3d: -0.04, change7d: -0.09, change14d: -0.02, change30d: 0.11, marketplaceLinks: [], performerName: 'Fixture Performer', venueName: 'Fixture Arena', venueCity: 'New York', startAt: new Date(Date.now() + 30 * 86_400_000).toISOString() };
  }

  async getPriceHistory(): Promise<TicketDataHistory> {
    this.calls += 1;
    const points = this.series(60, 9000, -25);
    return { points, zones: [{ zone: 'Upper', points: this.series(60, 7500, -20) }, { zone: 'Lower', points: this.series(60, 12000, -30) }], onSaleAt: null, presaleAt: null };
  }

  async getSections(): Promise<string[]> {
    this.calls += 1;
    return ['101', '102', '201', '202'];
  }
}
