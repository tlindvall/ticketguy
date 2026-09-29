import { describe, expect, it } from 'vitest';
import { SeatDataClient, SeatDataError } from '@/lib/market/seatdata';

const KEY = 'ab'.repeat(32);
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('SeatData client', () => {
  it('rejects a malformed key before any call', () => {
    expect(() => new SeatDataClient('nope')).toThrow(SeatDataError);
  });

  it('sends the key as a bearer token and follows the stats cursor', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') });
      return new URL(url).searchParams.get('starting_after') ? reply(200, { data: [{ timestamp: 'b' }], has_more: false, next_cursor: null }) : reply(200, { data: [{ timestamp: 'a' }], has_more: true, next_cursor: 'c1' });
    }) as typeof fetch;
    const r = await new SeatDataClient(KEY, { fetchImpl }).eventStats(123, { start_date: '2026-09-20' });
    expect(r).toEqual({ snapshots: [{ timestamp: 'a' }, { timestamp: 'b' }], complete: true });
    expect(seen[0]!.url).toBe('https://seatdata.io/api/v1/events/123/stats?start_date=2026-09-20&limit=500');
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  it('retries a rate limit after Retry-After, then maps errors to their type without echoing the key', async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = (async () => (++n === 1 ? reply(429, { error: { type: 'rate_limit_error', code: 'x', message: 'slow down' } }, { 'retry-after': '2' }) : reply(401, { error: { type: 'authentication_error', code: 'bad', message: 'Invalid API key' } }))) as typeof fetch;
    const err = await new SeatDataClient(KEY, { fetchImpl, sleep: async (ms) => void waits.push(ms) }).account().catch((e) => e);
    expect(waits).toEqual([2000]);
    expect(err).toBeInstanceOf(SeatDataError);
    expect(err).toMatchObject({ type: 'authentication_error', status: 401 });
    expect(String(err.message)).not.toContain(KEY);
  });

  it('never retries asking SeatData to add an event (not idempotent)', async () => {
    let n = 0;
    const fetchImpl = (async () => (n++, reply(503, {}))) as typeof fetch;
    await expect(new SeatDataClient(KEY, { fetchImpl, sleep: async () => {} }).requestEvent('Rangers MSG 2026-10-30')).rejects.toMatchObject({ type: 'server_error', status: 503 });
    expect(n).toBe(1);
  });
});
