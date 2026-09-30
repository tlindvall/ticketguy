import type { RequestExtraction } from './types';
import { MARKETS } from './markets';

/**
 * A US state as a place in a request: "they're playing in Connecticut" names no city, but it is still a place,
 * and the search is the state's venues. Codes are the provider's stateCode values.
 */
export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** "CT", "ct", "Connecticut", "the state of Connecticut" → "CT"; anything else → null. */
export function stateCodeFor(s: string | null | undefined): string | null {
  const t = (s ?? '').trim().replace(/^(?:the\s+)?state\s+of\s+/i, '').replace(/\.$/, '');
  if (!t) return null;
  if (/^[a-z]{2}$/i.test(t) && US_STATES[t.toUpperCase()]) return t.toUpperCase();
  const lower = t.toLowerCase();
  for (const [code, name] of Object.entries(US_STATES)) if (name.toLowerCase() === lower) return code;
  return null;
}

// A state name that is also how people name a city: "New York" is the city, "Washington" is usually DC.
const CITY_FIRST = new Set(['NY', 'WA', 'DC']);

/**
 * A state given as the city ("Connecticut") is a state, not a town called Connecticut; a state given by name is
 * kept as its code. A metro ("NY", "New York") stays a metro.
 */
export function normalizePlace<T extends Pick<RequestExtraction, 'city' | 'state'>>(x: T): T {
  const state = stateCodeFor(x.state) ?? x.state;
  if (x.city) {
    const asState = stateCodeFor(x.city);
    if (asState && !CITY_FIRST.has(asState) && !MARKETS.some((m) => m.match.test(x.city!))) return { ...x, city: null, state: asState };
  }
  return state === x.state ? x : { ...x, state };
}

/** The place is a whole state: no city, and a state we know. */
export function stateOnly(x: Pick<RequestExtraction, 'city' | 'state'>): string | null {
  return x.city ? null : stateCodeFor(x.state);
}
