import { describe, expect, it } from 'vitest';
import { geohash, inMarket, isOutsideUs, marketById, marketFor, milesBetween } from '@/lib/domain/markets';
import { TicketmasterDiscoveryAdapter, parseDiscoveryEvent } from '@/lib/sources/adapters';

describe('markets: the whole US, by metro', () => {
  it('reads how people name a place', () => {
    expect(marketFor('LA')?.id).toBe('los-angeles');
    expect(marketFor('Los Angeles')?.id).toBe('los-angeles');
    expect(marketFor('Inglewood')?.id).toBe('los-angeles');
    expect(marketFor('Philly')?.id).toBe('philadelphia');
    expect(marketFor('the Bay Area')?.id).toBe('bay-area');
    expect(marketFor('Brooklyn')?.id).toBe('new-york');
    expect(marketFor('New York')?.id).toBe('new-york');
    expect(marketFor('Buffalo, NY')?.id).toBe('buffalo'); // "NY" in a state suffix is not New York City
    expect(marketFor('Boise')?.label).toBe('Boise'); // a US town with no metro is searched by name
    expect(marketFor('London')).toBeNull();
    expect(isOutsideUs('Toronto')).toBe(true);
    expect(marketFor(null)).toBeNull();
  });

  it('counts a venue in the market by distance, or by city when it has no coordinates', () => {
    const la = marketById('los-angeles');
    expect(inMarket({ city: 'Inglewood', latitude: 33.958, longitude: -118.3419 }, la)).toBe(true); // Kia Forum
    expect(inMarket({ city: 'San Diego', latitude: 32.7157, longitude: -117.1611 }, la)).toBe(false);
    expect(inMarket({ city: 'Anaheim', latitude: null, longitude: null }, la)).toBe(true);
    expect(inMarket({ city: 'Fresno', latitude: null, longitude: null }, la)).toBe(false);
    expect(Math.round(milesBetween(40.7128, -74.006, 34.0522, -118.2437) / 10) * 10).toBe(2450); // NYC to LA, great-circle
  });

  it('encodes a geohash the way the provider reads it', () => {
    expect(geohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj'); // the reference example
    expect(geohash(34.0522, -118.2437)).toHaveLength(7);
  });

  it('asks the provider by point and radius, and reads venue coordinates', async () => {
    const urls: string[] = [];
    const adapter = new TicketmasterDiscoveryAdapter('key', true, (async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ _embedded: { events: [] } }), { status: 200 });
    }) as unknown as typeof fetch);
    await adapter.discoverEvents({ keyword: '', classificationName: 'music', geoPoint: '9q5ctr1', radiusMiles: 45 });
    const q = new URL(urls[0]!).searchParams;
    expect([q.get('geoPoint'), q.get('radius'), q.get('unit'), q.get('city')]).toEqual(['9q5ctr1', '45', 'miles', null]);
    const e = parseDiscoveryEvent({ id: 'e1', name: 'Show', url: 'https://www.ticketmaster.com/e/1', dates: { start: { dateTime: '2026-10-03T03:00:00Z' }, timezone: 'America/Los_Angeles' }, _embedded: { venues: [{ id: 'v1', name: 'Kia Forum', city: { name: 'Inglewood' }, timezone: 'America/Los_Angeles', location: { latitude: '33.958', longitude: '-118.3419' } }] } });
    expect([e!.venue!.latitude, e!.venue!.longitude]).toEqual([33.958, -118.3419]);
  });
});
