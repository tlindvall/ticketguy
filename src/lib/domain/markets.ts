import { neighbourhoodFor } from './neighbourhoods';
/**
 * The US markets Ticket Guy answers for. A market is a metro, not a city: "LA" is Inglewood, Anaheim and
 * Pasadena too, so events are found by distance from the metro's centre (the provider's geo search) and a
 * venue counts as in the market when it is within the radius, or, when a venue has no coordinates on file,
 * when its city is one of the metro's cities.
 *
 * Coordinates are city centres, rounded; they only need to be good enough for a 35–50 mile radius.
 */
export type Market = {
  id: string;
  label: string;
  lat: number | null;
  lng: number | null;
  radiusMiles: number;
  timezone: string;
  /** How customers name it ("LA", "Philly", "the Bay Area"). Checked against the city they gave. */
  match: RegExp;
  /** Venue cities that count when a venue has no coordinates. Lowercase. */
  cities: string[];
  /** How the market's own teams are named: "Los Angeles Kings", "Anaheim Ducks". */
  teamNames: RegExp;
};

const m = (id: string, label: string, lat: number, lng: number, timezone: string, match: RegExp, cities: string[], teamNames: RegExp, radiusMiles = 40): Market => ({ id, label, lat, lng, radiusMiles, timezone, match, cities, teamNames });

export const MARKETS: Market[] = [
  m('new-york', 'New York', 40.7128, -74.006, 'America/New_York', /\b(new york city|nyc|manhattan|brooklyn|queens|bronx|staten island|long island|jersey city|hoboken|newark)\b|^\s*(?:(?:in|near|around)\s+)?(?:new york|ny)(?:\s*,\s*(?:ny|new york))?\s*$/i, ['new york', 'brooklyn', 'queens', 'bronx', 'the bronx', 'flushing', 'long island city', 'staten island', 'elmont', 'uniondale', 'newark', 'east rutherford', 'hoboken', 'jersey city'], /^(new york|brooklyn|new jersey|ny)\b/i, 35),
  m('los-angeles', 'Los Angeles', 34.0522, -118.2437, 'America/Los_Angeles', /\b(los angeles|l\.?a\.?|hollywood|inglewood|anaheim|pasadena|santa monica|long beach|burbank|orange county)\b/i, ['los angeles', 'inglewood', 'anaheim', 'pasadena', 'carson', 'long beach', 'hollywood', 'west hollywood', 'santa monica', 'burbank', 'glendale', 'universal city', 'irvine', 'costa mesa'], /^(los angeles|la|anaheim)\b/i, 45),
  m('chicago', 'Chicago', 41.8781, -87.6298, 'America/Chicago', /\b(chicago|chi-?town|evanston)\b/i, ['chicago', 'rosemont', 'evanston', 'bridgeview', 'tinley park'], /^chicago\b/i),
  m('dallas', 'Dallas-Fort Worth', 32.7767, -96.797, 'America/Chicago', /\b(dallas|fort worth|dfw|arlington|frisco|irving|plano)\b/i, ['dallas', 'fort worth', 'arlington', 'frisco', 'irving', 'grand prairie', 'plano'], /^(dallas|texas)\b/i),
  m('houston', 'Houston', 29.7604, -95.3698, 'America/Chicago', /\bhouston\b/i, ['houston', 'the woodlands', 'sugar land'], /^houston\b/i),
  m('washington', 'Washington, DC', 38.9072, -77.0369, 'America/New_York', /\b(washington,? ?d\.?c\.?|d\.?c\.?|arlington,? va|landover|bethesda)\b/i, ['washington', 'landover', 'arlington', 'vienna', 'columbia', 'bristow'], /^washington\b/i),
  m('philadelphia', 'Philadelphia', 39.9526, -75.1652, 'America/New_York', /\b(philadelphia|philly|camden)\b/i, ['philadelphia', 'camden', 'chester'], /^philadelphia\b/i),
  m('miami', 'Miami', 25.7617, -80.1918, 'America/New_York', /\b(miami|fort lauderdale|sunrise|miami gardens|miami beach)\b/i, ['miami', 'miami gardens', 'miami beach', 'sunrise', 'fort lauderdale', 'hollywood'], /^(miami|florida)\b/i),
  m('atlanta', 'Atlanta', 33.749, -84.388, 'America/New_York', /\b(atlanta|atl)\b/i, ['atlanta', 'alpharetta', 'duluth'], /^atlanta\b/i),
  m('boston', 'Boston', 42.3601, -71.0589, 'America/New_York', /\b(boston|foxborough|cambridge,? ma)\b/i, ['boston', 'foxborough', 'cambridge', 'somerville', 'mansfield'], /^(boston|new england)\b/i),
  m('phoenix', 'Phoenix', 33.4484, -112.074, 'America/Phoenix', /\b(phoenix|scottsdale|tempe|glendale,? az)\b/i, ['phoenix', 'glendale', 'tempe', 'scottsdale', 'mesa'], /^(phoenix|arizona)\b/i),
  m('bay-area', 'the Bay Area', 37.7749, -122.4194, 'America/Los_Angeles', /\b(san francisco|sf|bay area|oakland|san jose|santa clara|berkeley)\b/i, ['san francisco', 'oakland', 'san jose', 'santa clara', 'berkeley', 'mountain view'], /^(san francisco|golden state|oakland|san jose)\b/i, 50),
  m('seattle', 'Seattle', 47.6062, -122.3321, 'America/Los_Angeles', /\bseattle\b/i, ['seattle', 'tacoma', 'everett'], /^seattle\b/i),
  m('detroit', 'Detroit', 42.3314, -83.0458, 'America/Detroit', /\bdetroit\b/i, ['detroit', 'clarkston', 'sterling heights'], /^detroit\b/i),
  m('minneapolis', 'Minneapolis-St. Paul', 44.9778, -93.265, 'America/Chicago', /\b(minneapolis|st\.? paul|twin cities)\b/i, ['minneapolis', 'st. paul', 'saint paul', 'bloomington'], /^minnesota\b/i),
  m('san-diego', 'San Diego', 32.7157, -117.1611, 'America/Los_Angeles', /\bsan diego\b/i, ['san diego', 'chula vista'], /^san diego\b/i),
  m('tampa', 'Tampa Bay', 27.9506, -82.4572, 'America/New_York', /\b(tampa|st\.? petersburg|clearwater)\b/i, ['tampa', 'st. petersburg', 'clearwater'], /^tampa\b/i),
  m('denver', 'Denver', 39.7392, -104.9903, 'America/Denver', /\b(denver|morrison|red rocks)\b/i, ['denver', 'morrison', 'englewood', 'commerce city'], /^(denver|colorado)\b/i),
  m('baltimore', 'Baltimore', 39.2904, -76.6122, 'America/New_York', /\bbaltimore\b/i, ['baltimore'], /^baltimore\b/i, 30),
  m('st-louis', 'St. Louis', 38.627, -90.1994, 'America/Chicago', /\b(st\.? louis|saint louis)\b/i, ['st. louis', 'saint louis', 'maryland heights'], /^(st\.? louis|saint louis)\b/i),
  m('orlando', 'Orlando', 28.5383, -81.3792, 'America/New_York', /\borlando\b/i, ['orlando', 'kissimmee'], /^orlando\b/i),
  m('charlotte', 'Charlotte', 35.2271, -80.8431, 'America/New_York', /\bcharlotte\b/i, ['charlotte', 'concord'], /^(charlotte|carolina)\b/i),
  m('san-antonio', 'San Antonio', 29.4241, -98.4936, 'America/Chicago', /\bsan antonio\b/i, ['san antonio'], /^san antonio\b/i),
  m('portland', 'Portland', 45.5152, -122.6784, 'America/Los_Angeles', /\bportland\b/i, ['portland', 'ridgefield'], /^portland\b/i),
  m('sacramento', 'Sacramento', 38.5816, -121.4944, 'America/Los_Angeles', /\bsacramento\b/i, ['sacramento', 'wheatland'], /^sacramento\b/i),
  m('pittsburgh', 'Pittsburgh', 40.4406, -79.9959, 'America/New_York', /\bpittsburgh\b/i, ['pittsburgh', 'burgettstown'], /^pittsburgh\b/i),
  m('austin', 'Austin', 30.2672, -97.7431, 'America/Chicago', /\baustin\b/i, ['austin', 'round rock'], /^austin\b/i),
  m('las-vegas', 'Las Vegas', 36.1699, -115.1398, 'America/Los_Angeles', /\b(las vegas|vegas|paradise,? nv|henderson)\b/i, ['las vegas', 'paradise', 'henderson'], /^(las vegas|vegas)\b/i),
  m('cincinnati', 'Cincinnati', 39.1031, -84.512, 'America/New_York', /\bcincinnati\b/i, ['cincinnati', 'newport'], /^cincinnati\b/i),
  m('kansas-city', 'Kansas City', 39.0997, -94.5786, 'America/Chicago', /\bkansas city\b/i, ['kansas city'], /^kansas city\b/i),
  m('columbus', 'Columbus', 39.9612, -82.9988, 'America/New_York', /\bcolumbus\b/i, ['columbus'], /^columbus\b/i),
  m('indianapolis', 'Indianapolis', 39.7684, -86.1581, 'America/Indiana/Indianapolis', /\b(indianapolis|indy)\b/i, ['indianapolis', 'noblesville'], /^(indiana|indianapolis)\b/i),
  m('cleveland', 'Cleveland', 41.4993, -81.6944, 'America/New_York', /\bcleveland\b/i, ['cleveland', 'cuyahoga falls'], /^cleveland\b/i),
  m('nashville', 'Nashville', 36.1627, -86.7816, 'America/Chicago', /\bnashville\b/i, ['nashville', 'franklin'], /^(nashville|tennessee)\b/i),
  m('milwaukee', 'Milwaukee', 43.0389, -87.9065, 'America/Chicago', /\bmilwaukee\b/i, ['milwaukee'], /^milwaukee\b/i),
  m('new-orleans', 'New Orleans', 29.9511, -90.0715, 'America/Chicago', /\b(new orleans|nola)\b/i, ['new orleans', 'metairie'], /^new orleans\b/i),
  m('salt-lake-city', 'Salt Lake City', 40.7608, -111.891, 'America/Denver', /\b(salt lake city|slc)\b/i, ['salt lake city', 'west valley city'], /^(utah|salt lake)\b/i),
  m('raleigh', 'Raleigh-Durham', 35.7796, -78.6382, 'America/New_York', /\b(raleigh|durham|chapel hill)\b/i, ['raleigh', 'durham', 'cary', 'chapel hill'], /^carolina\b/i),
  m('buffalo', 'Buffalo', 42.8864, -78.8784, 'America/New_York', /\bbuffalo\b/i, ['buffalo', 'orchard park'], /^buffalo\b/i),
  m('oklahoma-city', 'Oklahoma City', 35.4676, -97.5164, 'America/Chicago', /\b(oklahoma city|okc)\b/i, ['oklahoma city'], /^oklahoma city\b/i),
  m('memphis', 'Memphis', 35.1495, -90.049, 'America/Chicago', /\bmemphis\b/i, ['memphis'], /^memphis\b/i),
  m('jacksonville', 'Jacksonville', 30.3322, -81.6557, 'America/New_York', /\bjacksonville\b/i, ['jacksonville'], /^jacksonville\b/i),
];

export const DEFAULT_MARKET_ID = 'new-york';

export function marketById(id: string): Market {
  return MARKETS.find((x) => x.id === id) ?? MARKETS[0]!;
}

/** Places we do not cover yet: the service is US-only. */
const NON_US = /\b(london|paris|toronto|montreal|vancouver|berlin|dublin|madrid|barcelona|rome|amsterdam|sydney|melbourne|tokyo|mexico city|cancun|uk|england|scotland|canada|mexico|australia|france|germany|spain|italy|japan)\b/i;
export function isOutsideUs(place: string | null | undefined): boolean {
  return !!place && NON_US.test(place);
}

/**
 * The market a place names, or a single-city market for a US city we have no metro for ("Boise"), which is
 * searched by city name. Null when no place is given or the place is outside the US.
 */
export function marketFor(place: string | null | undefined, state?: string | null): Market | null {
  if (!place?.trim() || isOutsideUs(place)) return null;
  const known = MARKETS.find((x) => x.match.test(place));
  if (known) return known;
  // A neighbourhood is part of a metro, not a town of its own: "Bushwick" is New York, not a city called Bushwick.
  const hood = neighbourhoodFor(place);
  if (hood) return marketById(hood.marketId);
  const city = place.trim();
  return { id: `city:${city.toLowerCase()}${state ? `,${state.toLowerCase()}` : ''}`, label: city.replace(/\b\w/g, (c) => c.toUpperCase()), lat: null, lng: null, radiusMiles: 0, timezone: 'America/New_York', match: /$^/, cities: [city.toLowerCase()], teamNames: new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') };
}

export function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/** The market a team plays at home in, from its name ("Brooklyn Nets", "New York Knicks" → New York); null when unknown. */
export function teamHomeMarket(teamName: string): Market | null {
  return MARKETS.find((x) => x.teamNames.test(teamName.trim())) ?? null;
}

/** Whether a venue is in the market: within its radius when both have coordinates, else by city name. */
export function inMarket(v: { city: string | null; latitude?: number | null; longitude?: number | null }, market: Market): boolean {
  if (market.lat !== null && market.lng !== null && v.latitude != null && v.longitude != null) return milesBetween(market.lat, market.lng, v.latitude, v.longitude) <= market.radiusMiles;
  return !!v.city && market.cities.includes(v.city.trim().toLowerCase());
}

/** The provider's geo search takes a geohash; seven characters is about 150 metres, plenty for a metro. */
export function geohash(lat: number, lng: number, precision = 7): string {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let [latMin, latMax, lngMin, lngMax] = [-90, 90, -180, 180];
  let hash = '';
  let bit = 0;
  let ch = 0;
  let evenBit = true;
  while (hash.length < precision) {
    const value = evenBit ? lng : lat;
    const mid = evenBit ? (lngMin + lngMax) / 2 : (latMin + latMax) / 2;
    const upper = value >= mid;
    ch = (ch << 1) | (upper ? 1 : 0);
    if (evenBit) {
      if (upper) lngMin = mid;
      else lngMax = mid;
    } else if (upper) latMin = mid;
    else latMax = mid;
    evenBit = !evenBit;
    if (++bit === 5) {
      hash += base32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}
