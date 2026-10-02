/**
 * SeatData API client (https://seatdata.io). Market data, not a seller: it reports what resale listings and
 * sales look like on marketplaces (StubHub `sh`, Vivid Seats `vs`), so nothing it returns is ever a
 * purchasable offer. Endpoints and shapes follow the official SDK (github.com/SeatDataIO/python-sdk); the
 * listings endpoint's item shape is undocumented and is read defensively.
 *
 * Auth is `Authorization: Bearer <64-hex key>`. The key is never logged or echoed in errors.
 */

export const SEATDATA_BASE_URL = 'https://seatdata.io';

export type SeatDataEvent = {
  event_id: number;
  event_name: string;
  event_date: string;
  event_time?: string;
  tm_event_id?: string | null;
  days_on_seatdata?: number;
  first_seen_date?: string;
  venue_name: string;
  venue_city: string;
  venue_state: string;
  venue_tm_id?: string | null;
  performer?: string | null;
  event_type?: string | null;
};

export type SeatDataZoneStats = { zone_name: string; avg_price: number | null; median_price: number | null; get_in: number | null; get_in_qty2plus: number | null };

export type SeatDataStatsSnapshot = {
  timestamp: string;
  total_listings_all: number | null;
  total_listings_active: number | null;
  listing_fill_rate: number | null;
  avg_price: number | null;
  median_price: number | null;
  get_in: number | null;
  get_in_qty2plus: number | null;
  zones: SeatDataZoneStats[];
};

export type SeatDataSale = { source: 'sh' | 'vs' | string; listing_id: number | string; all_in_price: number | null; timestamp: number; quantity: number; price: number; zone: string; section: string; row: string };

type Page<T> = { data: T[]; has_more: boolean; next_cursor: string | null };

export type SeatDataErrorType = 'authentication_error' | 'subscription_required' | 'invalid_request' | 'not_found' | 'payment_required' | 'rate_limit_error' | 'server_error' | 'network_error' | 'budget_exhausted';

export class SeatDataError extends Error {
  constructor(
    readonly type: SeatDataErrorType,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

export class SeatDataClient {
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Every HTTP call made, for the daily budget and the usage log. */
  calls = 0;
  /**
   * No attempt, retries included, is made once `calls` reaches this (PW-CALL-BUDGET-01): the caller sets it from the
   * day's remaining allowance. Null means uncapped (probes and scripts).
   */
  callCap: number | null = null;

  constructor(apiKey: string, opts: { fetchImpl?: typeof fetch; baseUrl?: string; maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {}) {
    if (!/^[0-9a-f]{64}$/i.test(apiKey)) throw new SeatDataError('authentication_error', null, 'SeatData API key must be a 64-character hexadecimal string');
    this.key = apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = (opts.baseUrl ?? SEATDATA_BASE_URL).replace(/\/$/, '');
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request<T>(method: 'GET' | 'POST', path: string, q: Record<string, string | number | boolean | null | undefined> = {}, body?: unknown, retrySafe = true): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      if (this.callCap !== null && this.calls >= this.callCap) throw new SeatDataError('budget_exhausted', null, 'daily call allowance reached');
      this.calls += 1;
      try {
        res = await this.fetchImpl(url.toString(), { method, headers: { authorization: `Bearer ${this.key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        if (retrySafe && attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new SeatDataError('network_error', null, e instanceof Error ? e.name : 'network error');
      }
      if (res.ok) return (await res.json()) as T;
      if (retrySafe && RETRY_STATUS.has(res.status) && attempt < this.maxRetries) {
        const after = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      throw await errorFrom(res);
    }
  }

  account(): Promise<{ plans?: Array<{ id: string; name: string; status: string }>; rate_limits?: Record<string, { limit: number; window_seconds: number }> }> {
    return this.request('GET', '/api/v1/account');
  }

  usage(): Promise<{ period_start: string; period_end: string; totals: Record<string, number> }> {
    return this.request('GET', '/api/v1/usage');
  }

  searchEvents(q: { event_name?: string; event_date?: string; venue_name?: string; venue_city?: string; venue_state?: string; tm_event_id?: string; historical?: boolean; limit?: number; starting_after?: string }): Promise<Page<SeatDataEvent>> {
    return this.request('GET', '/api/v1/events/search', { ...q, historical: q.historical === undefined ? undefined : q.historical ? 'true' : 'false' });
  }

  /** Every stats snapshot in the window, following the cursor up to `maxPages`. */
  async eventStats(eventId: number | string, q: { start_date?: string; end_date?: string; maxPages?: number } = {}): Promise<{ snapshots: SeatDataStatsSnapshot[]; complete: boolean }> {
    const out: SeatDataStatsSnapshot[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < (q.maxPages ?? 5); page++) {
      const r: Page<SeatDataStatsSnapshot> = await this.request('GET', `/api/v1/events/${encodeURIComponent(String(eventId))}/stats`, { start_date: q.start_date, end_date: q.end_date, limit: 500, starting_after: cursor });
      out.push(...(r.data ?? []));
      if (!r.has_more || !r.next_cursor) return { snapshots: out, complete: true };
      cursor = r.next_cursor;
    }
    return { snapshots: out, complete: false };
  }

  eventSales(eventId: number | string, q: { source?: 'sh' | 'vs' | 'all'; limit?: number; starting_after?: string } = {}): Promise<Page<SeatDataSale> & { total_count?: number }> {
    return this.request('GET', `/api/v1/events/${encodeURIComponent(String(eventId))}/sales`, q);
  }

  /** Current listings. The item shape is undocumented; callers must treat every field as optional. */
  listings(eventId: number | string): Promise<{ listings?: Array<Record<string, unknown>> } & Record<string, unknown>> {
    return this.request('GET', '/api/v0.1/listings/get', { event_id: eventId });
  }

  /**
   * Current listings of an event named by its StubHub event id (the number in a StubHub link's /event/ path). SDK 1.2
   * documents this as `GET /api/v0.1.1/listings/get?event_id_sh=`: "every stored row of the event, active and
   * inactive". The item shape is still undocumented; callers treat every field as optional.
   */
  listingsByStubHubEvent(eventIdSh: number | string): Promise<{ listings?: Array<Record<string, unknown>>; has_refreshed?: number; last_refresh_timestamp?: number | null } & Record<string, unknown>> {
    return this.request('GET', '/api/v0.1.1/listings/get', { event_id_sh: eventIdSh });
  }

  /** Asks SeatData to start tracking an event it does not have. Not idempotent, so never retried. */
  requestEvent(searchQuery: string): Promise<Record<string, unknown>> {
    return this.request('POST', '/api/v0.4/events/event-request-add', {}, { search_query: searchQuery }, false);
  }
}

async function errorFrom(res: Response): Promise<SeatDataError> {
  const fallback: SeatDataErrorType = res.status === 401 ? 'authentication_error' : res.status === 402 ? 'payment_required' : res.status === 404 ? 'not_found' : res.status === 429 ? 'rate_limit_error' : res.status === 400 ? 'invalid_request' : 'server_error';
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const env = body as { error?: unknown } | null;
  if (env && typeof env.error === 'object' && env.error) {
    const e = env.error as { type?: string; message?: string };
    return new SeatDataError((e.type as SeatDataErrorType) ?? fallback, res.status, String(e.message ?? '').slice(0, 200));
  }
  if (env && typeof env.error === 'string') {
    const type = res.status === 401 && /subscription/i.test(env.error) ? 'subscription_required' : fallback;
    return new SeatDataError(type, res.status, env.error.slice(0, 200));
  }
  return new SeatDataError(fallback, res.status, `HTTP ${res.status}`);
}
