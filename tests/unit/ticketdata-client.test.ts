import { describe, expect, it } from 'vitest';
import { TicketDataClient, TicketDataError, TicketDataFixtureClient, dollarsToCents } from '@/lib/market/ticketdata';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('TicketData client', () => {
  it('sends no auth header and a browser user-agent', async () => {
    const seen: Array<{ url: string; auth: string | null; ua: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url, auth: h.get('authorization'), ua: h.get('user-agent') });
      return reply(200, { data: { name: 'X', get_in: 85.5 } });
    }) as typeof fetch;
    const d = await new TicketDataClient({ fetchImpl }).getEvent('22323960');
    expect(seen[0]!.url).toBe('https://data.ticketdata.com/api/events/22323960');
    expect(seen[0]!.auth).toBeNull();
    expect(seen[0]!.ua).toMatch(/Chrome/);
    expect(d?.getInPriceCents).toBe(8550);
  });

  it('parses defensively: unknown shapes become nulls, never a throw', async () => {
    const fetchImpl = (async () => reply(200, { data: { name: 'X', get_in: 'n/a', forecast: { direction: 'sideways' }, changes: { '7d': 'huge' }, marketplace_links: [{ url: 'not a url' }, { label: 'stubhub', url: 'https://stubhub.com/e/1' }] } })) as typeof fetch;
    const d = await new TicketDataClient({ fetchImpl }).getEvent('1');
    expect(d).toMatchObject({ getInPriceCents: null, forecastDirection: null, change7d: null });
    expect(d!.marketplaceLinks).toEqual([{ label: 'stubhub', url: 'https://stubhub.com/e/1' }]);
  });

  it('returns null on 404', async () => {
    const fetchImpl = (async () => reply(404, { error: 'nope' })) as typeof fetch;
    await expect(new TicketDataClient({ fetchImpl }).getEvent('999')).resolves.toBeNull();
  });

  it('retries a rate limit after Retry-After, then maps a server error', async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = (async () => (++n === 1 ? reply(429, { error: 'slow' }, { 'retry-after': '2' }) : reply(500, { error: 'boom' }))) as typeof fetch;
    const err = await new TicketDataClient({ fetchImpl, sleep: async (ms) => void waits.push(ms) }).getPriceHistory('1').catch((e) => e);
    expect(waits).toEqual([2000]);
    expect(err).toBeInstanceOf(TicketDataError);
    expect(err).toMatchObject({ type: 'server_error', status: 500 });
  });

  it('stops once the call cap is reached', async () => {
    const fetchImpl = (async () => reply(200, { data: [] })) as typeof fetch;
    const c = new TicketDataClient({ fetchImpl });
    c.callCap = 1;
    await c.getSections('1');
    await expect(c.getSections('1')).rejects.toMatchObject({ type: 'budget_exhausted' });
  });

  it('parses history points and zone series', async () => {
    const fetchImpl = (async () =>
      reply(200, {
        data: {
          history: [{ timestamp: '2026-09-01T12:00:00Z', get_in: 80, active_listings: 42 }, { timestamp: 'bogus', get_in: 1 }],
          zones: [{ zone_name: 'Upper', history: [{ timestamp: '2026-09-01T12:00:00Z', get_in: 60 }] }, { name: null }],
          on_sale_at: '2026-08-01T10:00:00Z',
        },
      })) as typeof fetch;
    const h = await new TicketDataClient({ fetchImpl }).getPriceHistory('1');
    expect(h.points).toHaveLength(1);
    expect(h.points[0]).toMatchObject({ getInCents: 8000, activeListings: 42 });
    expect(h.zones).toHaveLength(1);
    expect(h.zones[0]!.zone).toBe('Upper');
    expect(h.onSaleAt).toBe('2026-08-01T10:00:00Z');
  });
});

describe('dollarsToCents', () => {
  it('converts dollars and rejects junk', () => {
    expect(dollarsToCents(85.5)).toBe(8550);
    expect(dollarsToCents('$1,299.99')).toBe(129999);
    expect(dollarsToCents('n/a')).toBeNull();
    expect(dollarsToCents(-5)).toBeNull();
    expect(dollarsToCents(0)).toBeNull();
    expect(dollarsToCents(null)).toBeNull();
  });
});

describe('TicketData fixture client', () => {
  it('returns deterministic synthetic series without network', async () => {
    const f = new TicketDataFixtureClient(7);
    const h1 = await f.getPriceHistory();
    const h2 = await new TicketDataFixtureClient(7).getPriceHistory();
    expect(h1.points.length).toBeGreaterThan(30);
    // Same seed → same price path (timestamps anchor to call time, so compare values).
    expect(h1.points.map((p) => p.getInCents)).toEqual(h2.points.map((p) => p.getInCents));
    expect(h1.zones.map((z) => z.zone)).toEqual(['Upper', 'Lower']);
    const d = await f.getEvent('1');
    expect(d.getInPriceCents).toBe(8500);
  });
});
