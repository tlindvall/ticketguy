import { z } from 'zod';

/**
 * How much Ticket Guy invests in a request (service-depth policy, DECISION_LOG #61). A category sets the
 * business depth; evidence and rights decide what can actually be said or done. This module is pure: it maps
 * a category and an event's format to what work is allowed, and says whether an operation can run given the
 * rights, configuration and coverage the caller passes in. It never grants rights, and "unknown" is never
 * "available".
 *
 * Kept apart from advice/policy.ts, which decides what the evidence supports once the work has run.
 */

export const SERVICE_POLICY_VERSION = 'sd-1';

export type ServiceDepth = 'core' | 'compare' | 'guide' | 'outside';
const RANK: Record<ServiceDepth, number> = { outside: 0, guide: 1, compare: 2, core: 3 };

export const OPERATIONS = ['official_lookup', 'provided_offer_check', 'live_comparison', 'historical_context', 'trend_advice', 'market_tracking', 'price_watch', 'event_alert', 'staff_comparison'] as const;
export type Operation = (typeof OPERATIONS)[number];
export type CapabilityState = 'available' | 'unavailable' | 'unknown';

export type ReasonCode =
  | 'outside_product' | 'non_us_event' | 'operator_blocked' | 'unknown_format' | 'guide_official_only' | 'compare_no_tracking'
  | 'core_override_approved' | 'source_not_integrated' | 'source_access_unapproved' | 'event_not_covered' | 'product_not_equivalent'
  | 'group_unverified' | 'fees_unconfirmed' | 'history_not_comparable' | 'history_use_unapproved' | 'monitoring_unavailable'
  | 'delivery_disabled' | 'policy_changed' | 'budget_exhausted'
  // Why a depth was chosen, for staff; never shown to customers.
  | 'category_default' | 'touring_format' | 'club_or_local_format' | 'unknown_category' | 'festival_format';

export type EventFormat = 'touring' | 'club' | 'festival' | 'local' | 'unknown';

export type Limits = { officialDocuments: number; automatedOfferSources: number; proactiveClarifications: number; maxDisplayedOffers: number };

export type ServicePolicyDecision = {
  policyVersion: string;
  category: string;
  format: EventFormat | null;
  depth: ServiceDepth;
  reasons: ReasonCode[];
  overrideId: string | null;
  allowedOperations: Operation[];
  limits: Limits;
};

export type EventCapabilityDecision = {
  operation: Operation;
  state: CapabilityState;
  sourceIds: string[];
  reasons: ReasonCode[];
  evaluatedAt: string;
  expiresAt: string | null;
};

/** off: legacy behaviour, nothing recorded. shadow: decisions recorded, behaviour unchanged. enforce: the gates apply. */
export type PolicyMode = 'off' | 'shadow' | 'enforce';

// -------------------------------------------------------------------------------------------------
// Mapping
// -------------------------------------------------------------------------------------------------

/** The 29 routing keys (sources/routing.ts). `satisfies` below makes a missing or extra key a compile error. */
export const ROUTE_KEYS = [
  'nhl', 'nba', 'wnba', 'nfl', 'mlb', 'soccer', 'ncaa_regular', 'ncaa_championship', 'minor_league', 'high_school', 'combat', 'motorsport',
  'tennis_golf', 'emerging_sports', 'concert', 'club_concert', 'festival', 'electronic_nightlife', 'broadway', 'touring_theater', 'classical',
  'comedy', 'family', 'fairs_community', 'conventions', 'las_vegas', 'attractions', 'theme_parks', 'cinema',
] as const;
export type RouteKey = (typeof ROUTE_KEYS)[number];

/** Policy identifiers beyond the routing keys: a request-level intent, not necessarily a catalog event. */
export const OUTSIDE_INTENTS = ['classes_workshops', 'tours_experiences', 'participation_permits', 'travel_reservations', 'virtual_gambling'] as const;
export type OutsideIntent = (typeof OUTSIDE_INTENTS)[number];
export const EXTRA_POLICY_IDS = ['food_drink', 'unknown', ...OUTSIDE_INTENTS] as const;
export type PolicyCategory = RouteKey | (typeof EXTRA_POLICY_IDS)[number];

type Rule = {
  /** The depth when the format is known to fit the category's main case, or when format doesn't matter. */
  base: ServiceDepth;
  /** Depth for a club or small local format, when the category distinguishes one. */
  club?: ServiceDepth;
  /** Depth for a large touring (arena, stadium or theater) format, when it differs from base. */
  touring?: ServiceDepth;
  /** Depth while the format is unknown, when it differs from base; never above base. */
  unknown?: ServiceDepth;
  note: string;
};

export const DEPTH_RULES = {
  nhl: { base: 'core', note: 'Covered US game; home/away, opponent and season phase kept.' },
  nba: { base: 'core', note: 'Covered US game; current approved sources only.' },
  wnba: { base: 'core', note: 'Same standard as the men’s leagues.' },
  nfl: { base: 'core', note: 'Admission distinct from parking, PSLs and hospitality.' },
  mlb: { base: 'core', note: 'Exact game, family bundles and inclusions.' },
  soccer: { base: 'core', club: 'guide', note: 'US pro/international spectator match; local or amateur formats are Guide.' },
  ncaa_regular: { base: 'guide', note: 'Selected major games may be promoted by override.' },
  ncaa_championship: { base: 'compare', note: 'Selected championships/bowls may be promoted by override.' },
  minor_league: { base: 'guide', note: 'Official club route; no league-wide monitoring.' },
  high_school: { base: 'guide', note: 'Spectator admission only; operator block stays until changed.' },
  combat: { base: 'compare', note: 'Verified card/session and admission class; major cards by override.' },
  motorsport: { base: 'compare', note: 'Race/session/grounds/seat equivalence required.' },
  tennis_golf: { base: 'compare', note: 'Court/session/grounds/badge equivalence required.' },
  emerging_sports: { base: 'guide', note: 'Established major events by override.' },
  concert: { base: 'core', club: 'guide', unknown: 'compare', note: 'Established touring formats are Core; small local gigs Guide; unknown format Compare at most.' },
  club_concert: { base: 'guide', touring: 'compare', note: 'Touring act with reliable coverage can be Compare; no custom club adapter.' },
  festival: { base: 'compare', note: 'Music festivals only; food/community/film festivals use their own routes.' },
  electronic_nightlife: { base: 'guide', touring: 'core', note: 'An arena or theater electronic show is a concert; genre alone does not set depth.' },
  broadway: { base: 'compare', note: 'Exact US performance; rush/lottery are separate from purchasable seats.' },
  touring_theater: { base: 'compare', club: 'guide', note: 'Major touring productions; regional/local theater is Guide.' },
  classical: { base: 'guide', note: 'No separate history project.' },
  comedy: { base: 'guide', touring: 'compare', note: 'Club/local formats Guide; arena/theater headliners Compare.' },
  family: { base: 'compare', club: 'guide', note: 'Large touring shows; small local formats Guide; child/infant rules checked.' },
  fairs_community: { base: 'guide', note: 'A separately ticketed major concert is its own event.' },
  conventions: { base: 'guide', note: 'Badge/day/session checks; operator block stays until changed.' },
  las_vegas: { base: 'compare', club: 'guide', note: 'Major shows/residencies; attractions and local experiences Guide.' },
  attractions: { base: 'guide', note: 'Official route and timed-entry rules; operator block stays until changed.' },
  theme_parks: { base: 'guide', note: 'Named admission product only; operator block stays until changed.' },
  cinema: { base: 'guide', note: 'Named screening; operator block stays until changed.' },
  food_drink: { base: 'guide', note: 'Ticketed food/wine/beer festival or tasting: entry vs included tastings, age, official checkout.' },
  unknown: { base: 'guide', note: 'Pending identity: bounded clarification or official route; no resale fallback or market enrollment.' },
  classes_workshops: { base: 'outside', note: 'No class or course reservations.' },
  tours_experiences: { base: 'outside', note: 'No guided-tour booking; a ticketed exhibition is attractions.' },
  participation_permits: { base: 'outside', note: 'Race entries, registrations, park and camping permits.' },
  travel_reservations: { base: 'outside', note: 'Flights, trains, hotels, restaurant reservations.' },
  virtual_gambling: { base: 'outside', note: 'Online-only attendance and gambling entries.' },
} as const satisfies Record<PolicyCategory, Rule>;

const OPERATIONS_BY_DEPTH: Record<ServiceDepth, Operation[]> = {
  core: [...OPERATIONS],
  compare: ['official_lookup', 'provided_offer_check', 'live_comparison', 'event_alert'],
  guide: ['official_lookup', 'provided_offer_check'],
  outside: [],
};

/** Proposed operating defaults (configurable later), not measured optima. Stricter provider caps still apply. */
export const LIMITS: Record<ServiceDepth, Limits> = {
  core: { officialDocuments: 4, automatedOfferSources: 8, proactiveClarifications: 2, maxDisplayedOffers: 3 },
  compare: { officialDocuments: 3, automatedOfferSources: 4, proactiveClarifications: 1, maxDisplayedOffers: 3 },
  guide: { officialDocuments: 2, automatedOfferSources: 0, proactiveClarifications: 1, maxDisplayedOffers: 2 },
  outside: { officialDocuments: 0, automatedOfferSources: 0, proactiveClarifications: 0, maxDisplayedOffers: 0 },
};

// -------------------------------------------------------------------------------------------------
// Format: resolved from the venue and the event's own words, never from the genre
// -------------------------------------------------------------------------------------------------

const LARGE_VENUE = /\b(?:arena|stadium|amphithea(?:ter|tre)|coliseum|colosseum|dome|garden|field|ballpark|pavilion|bowl|forum|speedway|raceway|motor speedway|fairgrounds|center|centre|superdome|park)\b/i;
const THEATER_VENUE = /\b(?:theat(?:er|re)|opera house|auditorium|music hall|concert hall|symphony hall|palladium|playhouse|hall)\b/i;
const CLUB_VENUE = /\b(?:club|nightclub|lounge|bar|tavern|pub|saloon|warehouse|loft|basement|cellar|brewery|taproom|cafe|café|ballroom|mirage|underground|social|room)\b/i;
const CLUB_EVENT = /\b(?:dj set|all night long|open to close|b2b|extended set|after-?hours|afterparty|after party|rave|club night|late night)\b/i;
const LOCAL_EVENT = /\b(?:open mic|amateur|youth|academy|u-?\d{2}\b|community|local showcase|recital)\b/i;

/**
 * What kind of occasion the event is, from the venue and the event's name. Electronic music at an arena is a
 * touring concert and at a club it's a club night: the same genre, a different format (guide F01). Heuristic
 * and deliberately conservative: anything it can't place is unknown, which never raises depth.
 */
export function eventFormat(e: { category: string; name: string; venueName?: string | null }): EventFormat {
  const name = e.name;
  const venue = e.venueName ?? '';
  if (e.category === 'festival' || /\bfestival\b/i.test(name)) return 'festival';
  if (LOCAL_EVENT.test(name)) return 'local';
  if (CLUB_EVENT.test(name) || (venue && CLUB_VENUE.test(venue) && !LARGE_VENUE.test(venue))) return 'club';
  if (venue && (LARGE_VENUE.test(venue) || THEATER_VENUE.test(venue))) return 'touring';
  return 'unknown';
}

/** A catalog category the policy knows; anything else is `unknown`. */
export function policyCategory(category: string | null | undefined): PolicyCategory {
  return category && category in DEPTH_RULES ? (category as PolicyCategory) : 'unknown';
}

// -------------------------------------------------------------------------------------------------
// Overrides: staff-approved, scoped, expiring
// -------------------------------------------------------------------------------------------------

export const OverrideSchema = z.object({
  id: z.string().min(1),
  depth: z.enum(['core', 'compare']),
  eventIds: z.array(z.string()).default([]),
  entitySlugs: z.array(z.string()).default([]),
  owner: z.string().min(1),
  reason: z.string().min(1),
  expiresAt: z.string().datetime(),
  evidence: z.string().min(1),
});
export type DepthOverride = z.infer<typeof OverrideSchema>;

export function parseOverrides(raw: string): DepthOverride[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = z.array(OverrideSchema).safeParse(JSON.parse(trimmed));
  if (!parsed.success) throw new Error(`SERVICE_DEPTH_OVERRIDES is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  for (const o of parsed.data) if (!o.eventIds.length && !o.entitySlugs.length) throw new Error(`SERVICE_DEPTH_OVERRIDES ${o.id}: an override must name events or entities (no category-wide promotion)`);
  return parsed.data;
}

// -------------------------------------------------------------------------------------------------
// Resolution
// -------------------------------------------------------------------------------------------------

export type PolicyContext = {
  category: string | null;
  /** From eventFormat(); null when there's no event yet. */
  format?: EventFormat | null;
  /** A request-level intent outside launch scope, from outsideIntent(). */
  outsideIntent?: OutsideIntent | null;
  eventId?: string | null;
  entitySlug?: string | null;
  /** The event's country when known; anything but US is outside. */
  country?: string | null;
  blockedCategories: string[];
  overrides?: DepthOverride[];
  now: Date;
};

function depthFor(rule: Rule, format: EventFormat | null): { depth: ServiceDepth; reason: ReasonCode } {
  if ((format === 'club' || format === 'local') && rule.club) return { depth: rule.club, reason: 'club_or_local_format' };
  if (format === 'touring' && rule.touring) return { depth: rule.touring, reason: 'touring_format' };
  if ((format === 'unknown' || format === null) && rule.unknown) return { depth: rule.unknown, reason: 'unknown_format' };
  if (format === 'festival') return { depth: rule.base, reason: 'festival_format' };
  return { depth: rule.base, reason: format === 'touring' ? 'touring_format' : 'category_default' };
}

export function resolveServicePolicy(ctx: PolicyContext): ServicePolicyDecision {
  const make = (category: string, depth: ServiceDepth, reasons: ReasonCode[], ops: Operation[] = OPERATIONS_BY_DEPTH[depth], overrideId: string | null = null): ServicePolicyDecision => ({
    policyVersion: SERVICE_POLICY_VERSION, category, format: ctx.format ?? null, depth, reasons, overrideId, allowedOperations: ops, limits: LIMITS[depth],
  });
  if (ctx.outsideIntent) return make(ctx.outsideIntent, 'outside', ['outside_product']);
  const category = policyCategory(ctx.category);
  if (ctx.country && ctx.country !== 'US') return make(category, 'outside', ['non_us_event']);
  const rule: Rule = DEPTH_RULES[category];
  const { depth: byFormat, reason } = depthFor(rule, ctx.format ?? null);
  const reasons: ReasonCode[] = [category === 'unknown' ? 'unknown_category' : reason];
  // An operator block is a stronger denial than any depth: the official route at most, and no override lifts it.
  if (ctx.blockedCategories.includes(category)) return make(category, byFormat, [...reasons, 'operator_blocked'], ['official_lookup']);
  let depth = byFormat;
  let overrideId: string | null = null;
  const o = (ctx.overrides ?? []).find((x) => new Date(x.expiresAt) > ctx.now && ((ctx.eventId && x.eventIds.includes(ctx.eventId)) || (ctx.entitySlug && x.entitySlugs.includes(ctx.entitySlug))));
  if (o && RANK[o.depth] > RANK[depth] && category !== 'unknown' && rule.base !== 'outside') {
    depth = o.depth;
    overrideId = o.id;
    reasons.push('core_override_approved');
  }
  if (depth === 'guide') reasons.push('guide_official_only');
  if (depth === 'compare') reasons.push('compare_no_tracking');
  return make(category, depth, reasons, OPERATIONS_BY_DEPTH[depth], overrideId);
}

export function allows(d: ServicePolicyDecision, op: Operation): boolean {
  return d.allowedOperations.includes(op);
}

// -------------------------------------------------------------------------------------------------
// Capability: business policy AND current rights, configuration and coverage
// -------------------------------------------------------------------------------------------------

/** The source id a SeatData-backed price watch carries (DECISION_LOG #62). */
export const MARKET_WATCH_SOURCE = 'seatdata';
/** A price watch whose only source is SeatData's listings: a heads-up on listed prices, not a seller watch. */
export const isMarketWatch = (sourceIds: readonly string[]): boolean => sourceIds.length === 1 && sourceIds[0] === MARKET_WATCH_SOURCE;

export type AdapterFacts = { sourceId: string; implementation: string; enabled: boolean; capabilities: string[]; monitoringAllowed: boolean; accessApproved: boolean };

export type CapabilityContext = {
  decision: ServicePolicyDecision;
  adapters: AdapterFacts[];
  /** Sources that know this event: a mapped provider id, or a fixture source for a fixture event. */
  coveredSourceIds: string[];
  licence: { tracking: boolean; benchmark: boolean; advice: boolean };
  /** SeatData key present (a licence without a key polls nothing). */
  marketKey: boolean;
  watchSendEnabled: boolean;
  /**
   * SeatData as a price-watch source (DECISION_LOG #62): `alerts` when the licence allows alerts to customers (or
   * tracking while email is limited to the owner's testers), `covered` when SeatData follows this event.
   */
  market?: { alerts: boolean; covered: boolean };
  now: Date;
};

const DENIED_BY_DEPTH: Record<ServiceDepth, ReasonCode> = { outside: 'outside_product', guide: 'guide_official_only', compare: 'compare_no_tracking', core: 'policy_changed' };

export function evaluateOperationCapability(ctx: CapabilityContext, operation: Operation): EventCapabilityDecision {
  const at = ctx.now.toISOString();
  const out = (state: CapabilityState, reasons: ReasonCode[], sourceIds: string[] = [], expiresAt: string | null = null): EventCapabilityDecision => ({ operation, state, sourceIds, reasons, evaluatedAt: at, expiresAt });
  if (!allows(ctx.decision, operation)) return out('unavailable', ctx.decision.reasons.includes('operator_blocked') ? ['operator_blocked'] : ctx.decision.reasons.includes('non_us_event') ? ['non_us_event'] : [DENIED_BY_DEPTH[ctx.decision.depth]]);
  const usable = (need: string, extra: (a: AdapterFacts) => boolean = () => true) => ctx.adapters.filter((a) => a.enabled && a.accessApproved && a.capabilities.includes(need) && extra(a));
  switch (operation) {
    case 'official_lookup':
    case 'provided_offer_check':
    case 'staff_comparison':
      return out('available', []);
    case 'live_comparison': {
      const integrated = usable('quote_search');
      if (!integrated.length) return out('unavailable', ['source_not_integrated']);
      const covered = integrated.filter((a) => ctx.coveredSourceIds.includes(a.sourceId));
      return covered.length ? out('available', [], covered.map((a) => a.sourceId)) : out('unavailable', ['event_not_covered']);
    }
    case 'historical_context':
      return ctx.licence.benchmark ? out('available', []) : out('unavailable', ['history_use_unapproved']);
    case 'trend_advice':
      // The rights to use a trend in advice; whether the history is comparable is decided with the evidence.
      return ctx.licence.advice || ctx.licence.tracking ? out('available', []) : out('unavailable', ['history_use_unapproved']);
    case 'market_tracking':
      if (!ctx.marketKey) return out('unavailable', ['source_not_integrated']);
      return ctx.licence.tracking ? out('available', []) : out('unavailable', ['history_use_unapproved']);
    case 'price_watch': {
      if (!ctx.watchSendEnabled) return out('unavailable', ['delivery_disabled']);
      const monitors = usable('monitoring', (a) => a.monitoringAllowed);
      const covered = monitors.filter((a) => ctx.coveredSourceIds.includes(a.sourceId));
      if (covered.length) return out('available', [], covered.map((a) => a.sourceId));
      // SeatData's resale listings, when no seller can be monitored: a heads-up on listed prices, never a verified
      // offer. It needs the key, the alerts licence and the event followed on SeatData.
      if (ctx.marketKey && ctx.market?.alerts) return ctx.market.covered ? out('available', [], [MARKET_WATCH_SOURCE]) : out('unavailable', ['event_not_covered']);
      if (!monitors.length) return out('unavailable', ['monitoring_unavailable']);
      return out('unavailable', ['event_not_covered']);
    }
    case 'event_alert':
      return out('available', []);
  }
}

// -------------------------------------------------------------------------------------------------
// Request-level intents outside launch scope, and food/drink events
// -------------------------------------------------------------------------------------------------

const CLASSES = /\b(?:cooking|pottery|ceramics|yoga|dance|salsa|painting|paint(?:[- ]and[- ]| ?& ?)sip|art|photography|language|fitness|spin|pilates|wine[- ]making|cocktail[- ]making|mixology|baking|pasta[- ]making|sewing|coding|guitar|piano|drawing|improv|writing|knitting|candle[- ]making|flower[- ]arranging|floral)\s+(?:class(?:es)?|workshops?|courses?|lessons?)\b/i;
const TOURS = /\b(?:guided|walking|bus|boat|food|ghost|city|segway|bike|helicopter|studio|brewery|winery|distillery|hop[- ]on[- ]hop[- ]off|sightseeing|harbor|harbour)\s+tours?\b|\btours? of (?:the )?(?:city|studio|brewery|winery|distillery|stadium|ballpark|arena)\b/i;
const PERMITS = /\b(?:marathon|half[- ]marathon|5k|10k|triathlon|ironman|race)\s+(?:entry|entries|registration|bib|bibs|spot|place)\b|\b(?:register|registration|sign(?:ing)? up|enter|entry|a bib)\s+(?:for|in)\s+(?:the |a )?(?:[\w'-]+\s+){0,2}(?:marathon|half[- ]marathon|5k|10k|triathlon|ironman|fun run)\b|\b(?:park|camping|campsite|backcountry|hiking|fishing|hunting|climbing|wilderness|trail)\s+(?:permits?|reservations?|passes)\b|\bpermits?\b[^.?!]{0,40}\b(?:half dome|national park|trail|summit)\b|\bnational park\b[^.?!]{0,40}\b(?:permits?|pass|entry|reservations?)\b|\b(?:half dome|national park|campground|backcountry|wilderness)\s+(?:permits?|passes|reservations?)\b|\bathlete registration\b/i;
const TRAVEL = /\b(?:book|booking|find|get|need|buy|price|reserve)\s+(?:me\s+|us\s+)?(?:a\s+|an\s+|two\s+|2\s+|some\s+|cheap(?:est)?\s+)?(?:round[- ]trip\s+|one[- ]way\s+)?(?:flights?|plane tickets?|airfare|train tickets?|amtrak tickets?|bus tickets?|hotel(?: rooms?)?s?|airbnb|car rental|rental car)\b|\b(?:flights?|plane tickets?|airfare|train tickets?|amtrak tickets?|hotel rooms?)\s+(?:from|to)\s+[A-Z]|\b(?:dinner|restaurant|brunch|lunch)\s+reservations?\b|\breservation\s+(?:at|for)\s+(?:a |the )?(?:restaurant|dinner|brunch)\b|\bbook (?:a|us a) table at (?:a |the )?restaurant\b/i;
const VIRTUAL = /\b(?:livestream|live[- ]stream|streaming (?:pass|ticket|access)|virtual (?:tickets?|event|concert|attendance|seat)|online[- ]only|attend online|(?:watch|stream) (?:it |the (?:game|show|concert|fight) )?online|pay[- ]per[- ]view|ppv)\b|\b(?:sports ?book|sports betting|betting (?:odds|lines?|slip)|parlays?|wagers?|place a bet)\b/i;

/**
 * A request for something Ticket Guy doesn't do at launch, however ticket-like its wording ("two tickets for a
 * pasta-making class on Oct 5, $120"). A named performer or team makes it a ticket request instead, except for
 * online-only attendance and betting, which are outside whoever is named.
 */
export function outsideIntent(text: string, named: { performerOrTeam: string | null }): OutsideIntent | null {
  if (VIRTUAL.test(text)) return 'virtual_gambling';
  if (named.performerOrTeam) return null;
  if (PERMITS.test(text)) return 'participation_permits';
  if (TRAVEL.test(text)) return 'travel_reservations';
  if (TOURS.test(text)) return 'tours_experiences';
  if (CLASSES.test(text)) return 'classes_workshops';
  return null;
}

const FOOD_DRINK = /\b(?:food|wine|beer|craft beer|whiskey|whisky|bourbon|tequila|mezcal|cocktail|spirits|taco|bbq|barbecue|chocolate|cheese|oyster|seafood|burger|pizza|ramen|dumpling|lobster|chili|coffee)\s+(?:festival|fest|tasting|crawl|expo|walk|week)\b|\btasting (?:event|tickets?|pass|session)\b|\b(?:wine|beer|whiskey|bourbon) tastings?\b|\bfood (?:and|&) (?:wine|drinks?) (?:festival|fest|classic|expo|weekend|event)\b/i;

/** A ticketed food or drink event (Guide depth), from the customer's words when the catalog doesn't have it. */
export function isFoodDrink(text: string): boolean {
  return FOOD_DRINK.test(text);
}

/** Which claim kinds in an advice packet need which operation, so a stale draft can be checked at send time. */
export const CLAIM_OPERATION: Partial<Record<string, Operation>> = {
  current_offer: 'live_comparison',
  alternative_offer: 'live_comparison',
  option_count: 'live_comparison',
  benchmark_range: 'historical_context',
  trend_change: 'trend_advice',
  market_price: 'historical_context',
  market_benchmark: 'historical_context',
  market_supply: 'historical_context',
  market_read: 'trend_advice',
  alternative_market: 'live_comparison',
  checkpoint: 'price_watch',
};

/** The operations a set of claim kinds relies on. */
export function operationsForClaims(kinds: string[]): Operation[] {
  return [...new Set(kinds.map((k) => CLAIM_OPERATION[k]).filter((x): x is Operation => !!x))];
}
