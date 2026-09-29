/**
 * Neighbourhoods customers name ("the cooler venues in Bushwick", "something in Silver Lake"). A neighbourhood is
 * not a town: the provider files its venues under the borough or city ("Brooklyn", "Los Angeles"), so searching
 * for a city called "Bushwick" finds nothing. Each entry names the market it belongs to; New York's also carry a
 * centre and radius (venues are kept by distance, since the provider's city says only "Brooklyn") and the
 * borough to widen to when nothing is on.
 *
 * Centres are approximate neighbourhood centres; radii are generous, because the boundaries people use are.
 * `independentScene` marks places whose smaller venues mostly sell outside the official listings we read.
 */
export type Neighbourhood = {
  label: string;
  marketId: string;
  match: RegExp;
  centre?: { lat: number; lng: number; radiusMiles: number };
  /** The borough (an area in src/lib/domain/browse.ts) to widen to. */
  borough?: 'Brooklyn' | 'Manhattan' | 'Queens' | 'the Bronx';
  independentScene?: boolean;
};

const ny = (label: string, match: RegExp, lat: number, lng: number, radiusMiles: number, borough: Neighbourhood['borough'], independentScene = false): Neighbourhood => ({ label, marketId: 'new-york', match, centre: { lat, lng, radiusMiles }, borough, independentScene });
const metro = (label: string, marketId: string, match: RegExp): Neighbourhood => ({ label, marketId, match });

export const NEIGHBOURHOODS: readonly Neighbourhood[] = [
  // Brooklyn
  ny('Bushwick', /\b(bushwick|east williamsburg)\b/i, 40.6985, -73.9225, 1.4, 'Brooklyn', true),
  ny('Williamsburg', /\bwilliamsburg\b/i, 40.7115, -73.9585, 1.2, 'Brooklyn', true),
  ny('Greenpoint', /\bgreenpoint\b/i, 40.7295, -73.9515, 0.9, 'Brooklyn', true),
  ny('Ridgewood', /\bridgewood\b/i, 40.7043, -73.9018, 0.9, 'Queens', true),
  ny('Bed-Stuy', /\b(bed[- ]?stuy|bedford[- ]stuyvesant)\b/i, 40.6872, -73.9418, 1.0, 'Brooklyn', true),
  ny('Crown Heights', /\bcrown heights\b/i, 40.6694, -73.9422, 1.0, 'Brooklyn', true),
  ny('Park Slope', /\bpark slope\b/i, 40.671, -73.9814, 1.0, 'Brooklyn'),
  ny('Gowanus', /\bgowanus\b/i, 40.6733, -73.9903, 0.8, 'Brooklyn', true),
  ny('Prospect Heights', /\bprospect heights\b/i, 40.6775, -73.9692, 0.7, 'Brooklyn'),
  ny('Fort Greene', /\b(fort greene|clinton hill)\b/i, 40.69, -73.97, 0.8, 'Brooklyn'),
  ny('Downtown Brooklyn', /\b(downtown brooklyn|dumbo|brooklyn heights)\b/i, 40.6955, -73.9866, 1.0, 'Brooklyn'),
  ny('Red Hook', /\bred hook\b/i, 40.6734, -74.0083, 0.8, 'Brooklyn'),
  ny('Sunset Park', /\bsunset park\b/i, 40.6455, -74.0124, 1.0, 'Brooklyn'),
  ny('Flatbush', /\bflatbush\b/i, 40.6409, -73.9624, 1.0, 'Brooklyn'),
  ny('Coney Island', /\bconey island\b/i, 40.5755, -73.9707, 1.0, 'Brooklyn'),
  // Manhattan
  ny('the Lower East Side', /\b(lower east side|the les)\b/i, 40.715, -73.9843, 0.6, 'Manhattan', true),
  ny('the East Village', /\beast village\b/i, 40.7265, -73.9815, 0.6, 'Manhattan', true),
  ny('the West Village', /\b(west village|greenwich village)\b/i, 40.7336, -74.0027, 0.7, 'Manhattan', true),
  ny('SoHo', /\b(soho|noho|nolita)\b/i, 40.7233, -74.003, 0.6, 'Manhattan'),
  ny('Tribeca', /\btribeca\b/i, 40.7163, -74.0086, 0.5, 'Manhattan'),
  ny('Chelsea', /\b(chelsea|meatpacking)\b/i, 40.7465, -74.0014, 0.7, 'Manhattan'),
  ny('Midtown', /\b(midtown|times square|theater district|theatre district)\b/i, 40.7549, -73.984, 1.0, 'Manhattan'),
  ny("Hell's Kitchen", /\bhell'?s kitchen\b/i, 40.7638, -73.9918, 0.6, 'Manhattan'),
  ny('Harlem', /\bharlem\b/i, 40.8116, -73.9465, 1.2, 'Manhattan'),
  ny('the Upper West Side', /\b(upper west side|uws)\b/i, 40.787, -73.9754, 1.0, 'Manhattan'),
  ny('the Upper East Side', /\b(upper east side|ues)\b/i, 40.7736, -73.9566, 1.0, 'Manhattan'),
  ny('the Financial District', /\b(financial district|fidi)\b/i, 40.7075, -74.0113, 0.6, 'Manhattan'),
  ny('Washington Heights', /\b(washington heights|inwood)\b/i, 40.8417, -73.9394, 1.0, 'Manhattan'),
  // Queens
  ny('Astoria', /\bastoria\b/i, 40.7644, -73.9235, 1.2, 'Queens'),
  ny('Jackson Heights', /\bjackson heights\b/i, 40.7557, -73.8831, 0.8, 'Queens'),
  // Other metros: the neighbourhood is searched as its metro.
  metro('Silver Lake', 'los-angeles', /\b(silver ?lake|echo park|los feliz|highland park|eagle rock)\b/i),
  metro('West Hollywood', 'los-angeles', /\b(west hollywood|weho)\b/i),
  metro('Downtown LA', 'los-angeles', /\b(downtown la|dtla|koreatown|ktown|arts district)\b/i),
  metro('Venice', 'los-angeles', /\b(venice beach|venice, ca|culver city)\b/i),
  metro('Wicker Park', 'chicago', /\b(wicker park|logan square|bucktown|pilsen|wrigleyville|lakeview|river north|west loop|lincoln park)\b/i),
  metro('the Mission', 'bay-area', /\b(the mission|mission district|soma|haight|castro|north beach)\b/i),
  metro('East Austin', 'austin', /\b(east austin|south congress|sixth street|6th street|rainey street)\b/i),
  metro('East Nashville', 'nashville', /\b(east nashville|the gulch|broadway nashville)\b/i),
  metro('Wynwood', 'miami', /\b(wynwood|little havana|south beach|brickell|design district)\b/i),
  metro('Fishtown', 'philadelphia', /\b(fishtown|northern liberties|south philly)\b/i),
  metro('RiNo', 'denver', /\b(rino|lodo|five points denver)\b/i),
  metro('U Street', 'washington', /\b(u street|adams morgan|navy yard)\b/i),
  metro('Allston', 'boston', /\b(allston|cambridge, ma|somerville)\b/i),
];

export function neighbourhoodFor(place: string | null | undefined): Neighbourhood | null {
  if (!place?.trim()) return null;
  return NEIGHBOURHOODS.find((n) => n.match.test(place)) ?? null;
}
