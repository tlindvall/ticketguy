import { registryIds } from './registry';

/**
 * Versioned category routing (research master "Routing matrix by request", 29 routes).
 * Every reference is a registry ID and is validated at startup. Routes are configuration, not prompt text.
 */
export const ROUTING_VERSION = '1.0';

export const CORE: readonly string[] = ['ticketmaster', 'axs-us-axs-official-resale', 'seatgeek', 'stubhub', 'vivid-seats', 'tickpick', 'gametime'];
export const EXTENDED: readonly string[] = [
  'ticketiq', 'ticketnetwork', 'ticketsmarter', 'ticketcity', 'megaseats', 'gotickets', 'soldout-com', 'ticket-club', 'scorebig',
  'ticket-liquidator', 'event-tickets-center', 'tickets-center', 'ticketsonsale', 'ticketfaster', 'viagogo', 'seatpick',
];

export type CategoryRoute = {
  key: string;
  label: string;
  /** Registry IDs of official routing authorities to consult first (plus the event's own official seller, always). */
  officialStart: string[];
  routine: 'core_extended' | 'core_extended_where_listed' | 'primary_plus_exchanges' | 'official_first' | 'category_specific';
  conditional: string[];
  notes: string;
  /** Whether the pilot defaults treat this as supported automation scope. */
  pilotDefault: boolean;
};

export const CATEGORY_ROUTES: readonly CategoryRoute[] = [
  { key: 'nhl', label: 'NHL', officialStart: ['nhl-ticket-exchange'], routine: 'core_extended', conditional: ['fevo'], notes: 'Home team checkout is decisive; verify team provider exceptions (e.g. SeatGeek clubs).', pilotDefault: true },
  { key: 'nba', label: 'NBA', officialStart: ['nba-tickets'], routine: 'core_extended', conditional: [], notes: 'Team offers, theme nights, packs; suites only if requested.', pilotDefault: true },
  { key: 'wnba', label: 'WNBA', officialStart: ['wnba-tickets'], routine: 'core_extended_where_listed', conditional: [], notes: 'Exclude games outside the US.', pilotDefault: false },
  { key: 'nfl', label: 'NFL', officialStart: ['nfl-tickets'], routine: 'core_extended', conditional: ['on-location'], notes: 'Distinguish parking and PSLs from admission.', pilotDefault: false },
  { key: 'mlb', label: 'MLB', officialStart: ['mlb-tickets'], routine: 'core_extended', conditional: ['fevo', 'tickets-com-provenue', 'seatgeek'], notes: 'SeatGeek is the official fan-to-fan marketplace; verify food/parking inclusions.', pilotDefault: true },
  { key: 'soccer', label: 'MLS / NWSL / other US soccer', officialStart: ['mls-tickets', 'nwsl'], routine: 'core_extended_where_listed', conditional: [], notes: 'Supporter-section rules; US-hosted matches only.', pilotDefault: false },
  { key: 'ncaa_regular', label: 'NCAA regular season', officialStart: [], routine: 'core_extended_where_listed', conditional: ['paciolan-evenue', 'ticketmaster', 'seatgeek', 'tickets-com-provenue', 'vivenu', 'ticketreturn', 'hometown-ticketing'], notes: 'School athletics ticket office first.', pilotDefault: false },
  { key: 'ncaa_championship', label: 'NCAA championship / bowl', officialStart: ['ncaa-tickets'], routine: 'core_extended_where_listed', conditional: [], notes: 'Authorized hospitality, donor/student eligibility.', pilotDefault: false },
  { key: 'minor_league', label: 'Minor-league / independent sports', officialStart: ['milb-tickets'], routine: 'core_extended_where_listed', conditional: ['etix', 'ticketreturn', 'tickets-com-provenue', 'vivenu', 'paciolan-evenue'], notes: 'C + E only where the event exists there.', pilotDefault: false },
  { key: 'high_school', label: 'High school / youth sports', officialStart: [], routine: 'official_first', conditional: ['gofan', 'hometown-ticketing'], notes: 'Resale only when specifically valid; never compare athlete registration with spectator admission.', pilotDefault: false },
  { key: 'combat', label: 'UFC / boxing / WWE / AEW', officialStart: ['wwe-events', 'aew-events'], routine: 'core_extended', conditional: [], notes: 'Session/card changes, venue restrictions.', pilotDefault: false },
  { key: 'motorsport', label: 'NASCAR / INDYCAR / NHRA / US F1', officialStart: ['nascar-tickets', 'indycar-schedule', 'nhra-schedule'], routine: 'core_extended_where_listed', conditional: ['formula-1-ticket-store', 'f1-experiences'], notes: 'Race vs qualifying vs weekend; grounds vs seats.', pilotDefault: false },
  { key: 'tennis_golf', label: 'Tennis / golf', officialStart: ['us-open-tennis', 'masters-tickets'], routine: 'core_extended_where_listed', conditional: [], notes: 'Court/session/grounds distinctions; badge/transfer rules.', pilotDefault: false },
  { key: 'emerging_sports', label: 'Rodeo / PBR / lacrosse / emerging / esports', officialStart: ['pbr'], routine: 'core_extended_where_listed', conditional: ['etix', 'tixr', 'eventbrite', 'showclix-leap-events'], notes: 'Official platform may be a branded storefront.', pilotDefault: false },
  { key: 'concert', label: 'Arena / stadium concert', officialStart: ['live-nation', 'aeg-presents'], routine: 'core_extended', conditional: ['ticketstoday', 'cashortrade', 'tixel-us', 'ticketswap', 'american-express-experiences', 'citi-entertainment', 'capital-one-entertainment'], notes: 'Artist presales, permitted face-value exchanges, cardholder offers.', pilotDefault: true },
  { key: 'club_concert', label: 'Club / independent concert', officialStart: [], routine: 'primary_plus_exchanges', conditional: ['dice', 'ticketweb', 'etix', 'eventim-us-see-tickets-us', 'tixr', 'prekindle', 'eventbrite', 'venuepilot', 'cashortrade', 'tixel-us', 'ticketswap'], notes: 'Official waitlists.', pilotDefault: true },
  { key: 'festival', label: 'Festival', officialStart: [], routine: 'primary_plus_exchanges', conditional: ['front-gate-tickets', 'axs-us-axs-official-resale', 'tixr', 'eventim-us-see-tickets-us', 'etix', 'ticket-fairy', 'cashortrade', 'tixel-us', 'ticketswap'], notes: 'Camping/parking separate.', pilotDefault: false },
  { key: 'electronic_nightlife', label: 'Electronic music / nightlife', officialStart: [], routine: 'primary_plus_exchanges', conditional: ['dice', 'resident-advisor-ra-tickets', 'shotgun', 'posh', 'ticket-fairy', 'tixr', 'eventbrite'], notes: 'Entry time, age, table vs individual admission.', pilotDefault: false },
  { key: 'broadway', label: 'Broadway / Off-Broadway', officialStart: ['broadway-org'], routine: 'category_specific', conditional: ['telecharge', 'broadway-direct', 'todaytix', 'broadwaybox', 'playbill-discounts', 'theatermania', 'tkts-by-tdf', 'tdf-membership', 'telecharge-lottery-rush', 'broadway-direct-lottery', 'broadway-com', 'broadway-inbound'], notes: 'Official seller + TodayTix + applicable C/E; rush/lottery separate from purchasable.', pilotDefault: false },
  { key: 'touring_theater', label: 'Touring Broadway / regional theater', officialStart: [], routine: 'category_specific', conditional: ['todaytix', 'lucky-seat', 'audienceview-ovationtix', 'spektrix', 'tessitura'], notes: 'Local offer codes, student/senior rush.', pilotDefault: false },
  { key: 'classical', label: 'Orchestra / opera / ballet / dance', officialStart: [], routine: 'category_specific', conditional: ['todaytix', 'tessitura', 'spektrix', 'audienceview-ovationtix'], notes: 'Subscriber/student offers when eligible.', pilotDefault: false },
  { key: 'comedy', label: 'Comedy', officialStart: [], routine: 'category_specific', conditional: ['ticketweb', 'etix', 'tixr', 'prekindle', 'eventbrite', 'helium-comedy', 'comedy-cellar'], notes: 'Arena: C + E; club: direct first; minimum spend and seating assignment.', pilotDefault: false },
  { key: 'family', label: 'Family shows / circus / touring spectacle', officialStart: [], routine: 'core_extended_where_listed', conditional: ['groupon', 'fever'], notes: 'Child/lap-seat policy.', pilotDefault: false },
  { key: 'fairs_community', label: 'Fairs / local festivals / community events', officialStart: [], routine: 'official_first', conditional: ['etix', 'ticketspice', 'big-tickets', 'freshtix', 'ticketleap', 'humanitix-us', 'events-com'], notes: 'C/E only for separately ticketed major shows.', pilotDefault: false },
  { key: 'conventions', label: 'Conventions / fan expos / film festivals', officialStart: [], routine: 'official_first', conditional: ['showclix-leap-events', 'eventbrite', 'tixr', 'universe', 'ticket-fairy'], notes: 'Badge transfer/name rules.', pilotDefault: false },
  { key: 'las_vegas', label: 'Las Vegas entertainment', officialStart: [], routine: 'category_specific', conditional: ['vegas-com', 'tix4-tix4vegas', 'todaytix', 'groupon', 'fever'], notes: 'Seat categories and pickup conditions.', pilotDefault: false },
  { key: 'attractions', label: 'Museums / timed exhibits / attractions', officialStart: [], routine: 'category_specific', conditional: ['fever', 'tiqets', 'groupon', 'universe', 'simpletix', 'citypass'], notes: 'Exact product match required.', pilotDefault: false },
  { key: 'theme_parks', label: 'Theme parks', officialStart: [], routine: 'category_specific', conditional: ['undercover-tourist'], notes: 'Optional expansion.', pilotDefault: false },
  { key: 'cinema', label: 'Cinema', officialStart: [], routine: 'category_specific', conditional: ['fandango', 'atom-tickets'], notes: 'Optional expansion.', pilotDefault: false },
];

export function validateRouting(): void {
  const ids = registryIds();
  const bad: string[] = [];
  for (const id of [...CORE, ...EXTENDED]) if (!ids.has(id)) bad.push(id);
  for (const r of CATEGORY_ROUTES) for (const id of [...r.officialStart, ...r.conditional]) if (!ids.has(id)) bad.push(`${r.key}:${id}`);
  const keys = new Set<string>();
  for (const r of CATEGORY_ROUTES) {
    if (keys.has(r.key)) bad.push(`duplicate route ${r.key}`);
    keys.add(r.key);
  }
  if (CATEGORY_ROUTES.length !== 29) bad.push(`expected 29 routes, found ${CATEGORY_ROUTES.length}`);
  if (bad.length) throw new Error(`Routing configuration references unknown registry IDs: ${bad.join(', ')}`);
}

export function routeFor(category: string): CategoryRoute | null {
  return CATEGORY_ROUTES.find((r) => r.key === category) ?? null;
}

/** Source plan for a request: ordered list of registry IDs that the policy requires checking. */
export function sourcePlan(category: string): { required: string[]; conditional: string[] } {
  const route = routeFor(category);
  if (!route) return { required: [], conditional: [] };
  const required = new Set<string>(route.officialStart);
  if (route.routine === 'core_extended' || route.routine === 'core_extended_where_listed') {
    CORE.forEach((s) => required.add(s));
    EXTENDED.forEach((s) => required.add(s));
  } else if (route.routine === 'primary_plus_exchanges') {
    CORE.forEach((s) => required.add(s));
  }
  return { required: [...required], conditional: route.conditional.filter((c) => !required.has(c)) };
}
