import { describe, expect, it } from 'vitest';
import { marketFor } from '@/lib/domain/markets';
import { areaFor, venueInArea } from '@/lib/domain/browse';
import { raPointer } from '@/lib/sources/resident-advisor';

describe('neighbourhoods', () => {
  it('belong to their metro instead of becoming a town of their own', () => {
    expect(marketFor('Bushwick')?.id).toBe('new-york');
    expect(marketFor('the Lower East Side')?.id).toBe('new-york');
    expect(marketFor('Silver Lake')?.id).toBe('los-angeles');
    expect(marketFor('Wicker Park')?.id).toBe('chicago');
    // A city named with the neighbourhood still wins: "Midtown Atlanta" is Atlanta.
    expect(marketFor('Midtown Atlanta')?.id).toBe('atlanta');
    // A town we don't know is still searched by its own name.
    expect(marketFor('Boise')?.id).toBe('city:boise');
  });

  it('a New York neighbourhood is kept by distance and widens to its borough', () => {
    const a = areaFor('like bushwick')!;
    expect(a.label).toBe('Bushwick');
    expect(a.parent?.label).toBe('Brooklyn');
    expect(a.independentScene).toBe(true);
    expect(venueInArea(a, { city: 'Brooklyn', latitude: 40.7094, longitude: -73.9232 })).toBe(true); // Elsewhere
    expect(venueInArea(a, { city: 'Brooklyn', latitude: 40.6826, longitude: -73.9754 })).toBe(false); // Barclays Center
    expect(venueInArea(a, { city: 'Brooklyn', latitude: null, longitude: null })).toBe(false); // no coordinates: the borough fallback has it
    expect(areaFor('Bushwick, Brooklyn')?.label).toBe('Bushwick');
    expect(areaFor('Brooklyn')?.label).toBe('Brooklyn');
  });

  it('Resident Advisor links only cities whose page was checked', () => {
    expect(raPointer('new-york')?.url).toBe('https://ra.co/events/us/newyork');
    expect(raPointer('chicago')).toBeNull();
    expect(raPointer(null)).toBeNull();
  });
});
