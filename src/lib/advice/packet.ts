import type { MarketBasis, MarketContext } from '@/lib/market/series';
import { createHash } from 'node:crypto';
import { formatUsd, perPersonCents } from '@/lib/domain/money';
import type { BenchmarkResult } from './benchmark';
import type { TrendResult } from './trend';
import type { PolicyResult, CustomerPriorities } from './policy';
import type { Evaluated } from '@/lib/domain/comparison';

/**
 * Typed evidence packet (API_AND_DATA_CONTRACTS §10). Every fact the customer sees is a server-rendered
 * claim with an ID, scope and allowed wording. The model may only reference claim IDs.
 */
export type ClaimKind = 'current_offer' | 'alternative_offer' | 'benchmark_range' | 'trend_change' | 'option_count' | 'coverage' | 'entry_reference' | 'checkpoint' | 'missing_history' | 'observation_time' | 'quoted_price' | 'face_value' | 'official_sale' | 'market_price' | 'market_benchmark' | 'market_supply';

export type ClaimRecord = {
  id: string;
  kind: ClaimKind;
  text: string; // server-rendered sentence
  values: Record<string, string | number | null>;
  scope: { quantity: number | null; seatZone: string | null; feeBasis: string | null; observedAt: string | null };
  evidenceIds: string[];
  methodVersion: string | null;
  limitations: string[];
  /** Whether the claim may appear in customer-facing output (licensing / adequacy). */
  customerVisible: boolean;
  url?: string | null;
  /** What the link says ("Buy on Ticketmaster"); "View this offer" when not set. */
  linkLabel?: string | null;
};

export type AdvicePacket = {
  requestId: string;
  revision: number;
  verifiedOfferObservationIds: string[];
  basketKey: string;
  basketVersion: number;
  benchmarkRunId: string | null;
  trendRunId: string | null;
  historicalAdequacy: 'sufficient' | 'limited' | 'insufficient';
  trendAdequacy: 'sufficient' | 'insufficient';
  customerPriorities: Record<string, unknown>;
  policyVersion: string;
  decision: PolicyResult['decision'];
  reasonCodes: string[];
  abstentions: string[];
  claimRecords: ClaimRecord[];
  evidenceExpiresAt: string | null;
  nextCheckpointAt: string | null;
  stopConditions: string[];
  watchConsentReference: string | null;
  isFixture: boolean;
};

/** Display-only rounding for benchmark per-person figures; whole-party cents remain the source of truth. */
function roundToDollar(cents: number): number {
  return Math.round(cents / 100) * 100;
}

export function packetHash(p: AdvicePacket): string {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex');
}

export type BuildPacketArgs = {
  requestId: string;
  revision: number;
  quantity: number;
  eventLabel: string; // "New York Rangers vs ... — Madison Square Garden, Oct 3 7:00 PM ET"
  best: Evaluated | null;
  alternatives: Evaluated[]; // up to 2, different seat class or clearly labeled
  entryReference: Evaluated | null; // single-seat reference if verified
  benchmark: BenchmarkResult | null;
  benchmarkRunId: string | null;
  trend: TrendResult | null;
  trendRunId: string | null;
  policy: PolicyResult;
  priorities: CustomerPriorities;
  sourcesChecked: string[];
  sourcesUnavailable: Array<{ sourceId: string; status: string }>;
  independentOptionCount: number | null;
  observedAt: Date;
  evidenceExpiresAt: Date | null;
  basketKey: string;
  watchConsentReference: string | null;
  isFixture: boolean;
  /** The official general sale when it is open now (DECISION_LOG #36). */
  official?: { seller: string; url: string } | null;
  /** The provider's published face-value range per ticket, before fees. A reference, never an offer. */
  faceValue?: { minCents: number; maxCents: number } | null;
  /** A price the customer saw and asked about, per ticket; `assumedPerTicket` when they did not say. */
  quote?: { perTicketCents: number; assumedPerTicket: boolean } | null;
  /**
   * Resale market statistics (DECISION_LOG #44): listed prices before fees, per ticket, never an offer.
   * `visible` is the licence's customer-display right; without it the claims are staff-only.
   */
  market?: { basis: MarketBasis | null; context: MarketContext | null; supply: MarketContext['supply']; comparableLabel: string | null; visible: boolean } | null;
};

/** Resale market claims. Every number is the calculated context's; wording says what the figure is and is not. */
function marketClaims(a: BuildPacketArgs, obs: string): ClaimRecord[] {
  const m = a.market;
  if (!m) return [];
  const out: ClaimRecord[] = [];
  const q = a.quantity;
  const c = m.context;
  const common = { evidenceIds: [], methodVersion: c?.methodVersion ?? 'market-1.0', customerVisible: m.visible };
  const supplyText = (s: MarketContext['supply']) =>
    s.now === null ? '' : s.before !== null && s.hours !== null && s.trend !== 'stable' && s.trend !== 'unknown' ? ` About ${s.now} listings are up, ${s.trend === 'shrinking' ? 'down' : 'up'} from ${s.before} over the last ${s.hours} hours.` : ` About ${s.now} listings are up.`;
  if (c && c.current && c.adequacy === 'sufficient') {
    const what = m.basis === 'pair' ? 'for two tickets together' : 'for a single ticket';
    const w = c.h72 ?? c.h24;
    const when = w ? (w.hours >= 72 ? 'three days ago' : 'a day ago') : null;
    const move = !w || !when ? '' : c.direction === 'down' ? ` That’s down from ${formatUsd(w.fromCents)} ${when}.` : c.direction === 'up' ? ` That’s up from ${formatUsd(w.fromCents)} ${when}.` : ` About the same as ${when}.`;
    out.push({
      id: 'C_MARKET',
      kind: 'market_price',
      text: `Resale listings ${what} currently start at ${formatUsd(c.current.priceCents)} a ticket (listed price, before fees).${move}${supplyText(m.supply)}`,
      values: { priceCents: c.current.priceCents, fromCents: w?.fromCents ?? null, windowHours: w?.hours ?? null, direction: c.direction, listings: m.supply.now, listingsBefore: m.supply.before },
      scope: { quantity: m.basis === 'pair' ? 2 : 1, seatZone: c.zone, feeBasis: 'listed_before_fees', observedAt: c.current.at.toISOString() },
      limitations: ['listed_prices_before_fees', 'market_statistics_not_listings', 'past_movement_does_not_predict'],
      ...common,
    });
    if (c.typical) {
      out.push({
        id: 'C_MARKET_TYPICAL',
        kind: 'market_benchmark',
        text: `For ${c.typical.events} past ${m.comparableLabel ?? 'comparable'} games at this venue, the cheapest listed ${m.basis === 'pair' ? 'price for two together' : 'ticket'} at this point before the game was typically ${formatUsd(c.typical.p25Cents)}–${formatUsd(c.typical.p75Cents)} (median ${formatUsd(c.typical.medianCents)}).`,
        values: { events: c.typical.events, p25Cents: c.typical.p25Cents, medianCents: c.typical.medianCents, p75Cents: c.typical.p75Cents },
        scope: { quantity: m.basis === 'pair' ? 2 : 1, seatZone: c.zone, feeBasis: 'listed_before_fees', observedAt: obs },
        limitations: ['listed_prices_before_fees', 'comparable_games_same_venue'],
        ...common,
      });
    }
    if (a.quote) {
      const listed = c.current.priceCents;
      const verdict = a.quote.perTicketCents < listed ? `below the cheapest resale listing (${formatUsd(listed)} before fees), so it’s a good price if it’s genuine` : a.quote.perTicketCents <= Math.round(listed * 1.3) ? `about what the cheapest resale ticket (${formatUsd(listed)} before fees) comes to once fees are added` : `above the cheapest resale listing even allowing for fees (${formatUsd(listed)} before fees)`;
      out.push({
        id: 'C_QUOTE_MARKET',
        kind: 'quoted_price',
        text: `Against resale: ${formatUsd(a.quote.perTicketCents)} a ticket is ${verdict}.`,
        values: { perTicketCents: a.quote.perTicketCents, listedCents: listed },
        scope: { quantity: m.basis === 'pair' ? 2 : 1, seatZone: null, feeBasis: 'listed_before_fees', observedAt: c.current.at.toISOString() },
        limitations: ['listed_prices_before_fees', 'market_statistics_not_listings'],
        ...common,
      });
    }
  } else if (m.basis === null && m.supply.now !== null) {
    // Three or more: no group price series exists, so only the listing count is said, and said to be that.
    out.push({
      id: 'C_MARKET',
      kind: 'market_supply',
      text: `There are about ${m.supply.now} resale listings for this game${m.supply.before !== null && m.supply.hours !== null && m.supply.trend !== 'stable' && m.supply.trend !== 'unknown' ? `, ${m.supply.trend === 'shrinking' ? 'down' : 'up'} from ${m.supply.before} over the last ${m.supply.hours} hours` : ''}. That counts all listings, not blocks of ${q} seats together.`,
      values: { listings: m.supply.now, listingsBefore: m.supply.before, trend: m.supply.trend },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      limitations: ['all_listings_not_group_blocks'],
      ...common,
    });
  }
  return out;
}

/**
 * What a quoted price is next to the provider's face value. Face value is before fees, so a little above it
 * can still be the official price all-in; well above it is a resale markup.
 */
export function quoteVerdict(perTicketCents: number, face: { minCents: number; maxCents: number }): 'below' | 'within' | 'fees' | 'markup' {
  if (perTicketCents < face.minCents) return 'below';
  if (perTicketCents <= face.maxCents) return 'within';
  if (perTicketCents <= Math.round(face.maxCents * 1.35)) return 'fees';
  return 'markup';
}

export function buildPacket(a: BuildPacketArgs): AdvicePacket {
  const claims: ClaimRecord[] = [];
  const obs = a.observedAt.toISOString();
  const q = a.quantity;
  const noMarket = a.sourcesChecked.length === 0;

  // The customer's own question first: the price they saw, against what the provider publishes.
  if (a.quote) {
    const price = `${formatUsd(a.quote.perTicketCents)}${a.quote.assumedPerTicket ? ' (I’ve taken that as per ticket)' : ' a ticket'}`;
    const face = a.faceValue;
    const range = face ? `${formatUsd(face.minCents)}–${formatUsd(face.maxCents)} a ticket before fees` : null;
    const verdictText = face
      ? {
          below: `That’s below the face value Ticketmaster lists (${range}), so it’s a good price if the seats suit you.`,
          within: `That’s within the face value Ticketmaster lists (${range}), so it isn’t marked up.`,
          fees: `That’s a little above the face value Ticketmaster lists (${range}); fees alone can add that much, so it may well be the official price all-in.`,
          markup: `That’s well above the face value Ticketmaster lists (${range}), so you’d be paying a resale markup.`,
        }[quoteVerdict(a.quote.perTicketCents, face)]
      : a.official
        ? `Ticketmaster doesn’t publish a price range for this show, so I can’t size that against face value — but if ${formatUsd(a.quote.perTicketCents)} is ${a.official.seller}’s own price, it’s face value, not a resale markup.`
        : `I can’t see what sellers are charging for this show yet, so I can’t say whether that’s low or high.`;
    claims.push({
      id: 'C_QUOTE',
      kind: 'quoted_price',
      text: `You mentioned ${price}. ${verdictText}`,
      values: { perTicketCents: a.quote.perTicketCents, faceMinCents: face?.minCents ?? null, faceMaxCents: face?.maxCents ?? null },
      scope: { quantity: q, seatZone: null, feeBasis: 'face_value_before_fees', observedAt: obs },
      evidenceIds: [],
      methodVersion: 'quote-1.0',
      limitations: ['face_value_is_before_fees', 'not_a_listing'],
      customerVisible: true,
    });
  } else if (a.faceValue) {
    claims.push({
      id: 'C_FACE',
      kind: 'face_value',
      text: `Ticketmaster lists face value for this show at ${formatUsd(a.faceValue.minCents)}–${formatUsd(a.faceValue.maxCents)} a ticket before fees.`,
      values: { minCents: a.faceValue.minCents, maxCents: a.faceValue.maxCents },
      scope: { quantity: null, seatZone: null, feeBasis: 'face_value_before_fees', observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['face_value_is_before_fees', 'not_a_listing'],
      customerVisible: true,
    });
  }
  if (a.official) {
    claims.push({
      id: 'C_OFFICIAL',
      kind: 'official_sale',
      text: `It’s still on general sale on ${a.official.seller}, which is where I’d buy unless a resale seat is clearly cheaper.`,
      values: { seller: a.official.seller },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['sale_window_not_inventory'],
      customerVisible: true,
      url: a.official.url,
      linkLabel: `Buy on ${a.official.seller}`,
    });
  }

  if (a.best && a.best.comparableTotalCents !== null) {
    const total = a.best.comparableTotalCents;
    const pp = perPersonCents(total, q);
    claims.push({
      id: 'C_BEST',
      kind: 'current_offer',
      text: `${q} seat${q > 1 ? 's' : ''} together${a.best.offer.section ? ` in section ${a.best.offer.section}` : ''}: ${formatUsd(total)} total (${formatUsd(pp)} each) including the verified charges, checked ${obs}.`,
      values: { totalCents: total, perPersonCents: pp, section: a.best.offer.section, sourceId: a.best.offer.sourceId },
      scope: { quantity: q, seatZone: a.best.offer.seatClass ?? null, feeBasis: a.best.offer.priceCompleteness, observedAt: obs },
      evidenceIds: [a.best.offer.evidenceId],
      methodVersion: null,
      limitations: a.best.flags,
      customerVisible: true,
      url: a.best.offer.directPurchaseUrl,
    });
  }
  a.alternatives.slice(0, 2).forEach((alt, i) => {
    if (alt.comparableTotalCents === null) return;
    claims.push({
      id: `C_ALT${i + 1}`,
      kind: 'alternative_offer',
      text: `Alternative (${alt.offer.seatClass ?? alt.offer.admissionType}${alt.offer.section ? `, section ${alt.offer.section}` : ''}): ${formatUsd(alt.comparableTotalCents)} total for ${q}${alt.offer.priceCompleteness === 'verified_total' ? '' : ' (estimated; some charges unknown)'}.`,
      values: { totalCents: alt.comparableTotalCents, sourceId: alt.offer.sourceId },
      scope: { quantity: q, seatZone: alt.offer.seatClass ?? null, feeBasis: alt.offer.priceCompleteness, observedAt: obs },
      evidenceIds: [alt.offer.evidenceId],
      methodVersion: null,
      limitations: alt.flags,
      customerVisible: true,
      url: alt.offer.directPurchaseUrl,
    });
  });
  if (a.entryReference && a.entryReference.comparableTotalCents !== null) {
    claims.push({
      id: 'C_ENTRY',
      kind: 'entry_reference',
      text: `The cheapest single seat we verified is ${formatUsd(a.entryReference.comparableTotalCents)}${a.entryReference.offer.seatClass && a.best?.offer.seatClass && a.entryReference.offer.seatClass !== a.best.offer.seatClass ? ' in a different part of the venue' : ''} — an entry-price reference, not a price for ${q} together.`,
      values: { totalCents: a.entryReference.comparableTotalCents },
      scope: { quantity: 1, seatZone: a.entryReference.offer.seatClass ?? null, feeBasis: a.entryReference.offer.priceCompleteness, observedAt: obs },
      evidenceIds: [a.entryReference.offer.evidenceId],
      methodVersion: null,
      limitations: ['not_a_group_price'],
      customerVisible: true,
    });
  }
  if (a.benchmark && a.benchmark.adequacy !== 'insufficient' && a.benchmark.p25Cents !== null && a.benchmark.p75Cents !== null && a.benchmark.medianCents !== null) {
    const n = a.benchmark.independentEventCount;
    const small = a.benchmark.adequacy === 'limited';
    claims.push({
      id: 'C_BENCH',
      kind: 'benchmark_range',
      text: `${small ? `Across a small sample of ${n}` : `Across ${n}`} comparable past events, the best ${q}-seat options we observed at a similar point before the event were ${small ? '' : 'typically '}${formatUsd(roundToDollar(perPersonCents(Math.round(a.benchmark.p25Cents), q)))}–${formatUsd(roundToDollar(perPersonCents(Math.round(a.benchmark.p75Cents), q)))} per person (median ${formatUsd(roundToDollar(perPersonCents(Math.round(a.benchmark.medianCents), q)))}). These are observed asking prices, not sale prices.`,
      values: { events: n, p25Cents: a.benchmark.p25Cents, p75Cents: a.benchmark.p75Cents, medianCents: a.benchmark.medianCents },
      scope: { quantity: q, seatZone: null, feeBasis: 'verified_total', observedAt: null },
      evidenceIds: a.benchmark.representativeSnapshotIds,
      methodVersion: a.benchmark.methodVersion,
      limitations: [...a.benchmark.adequacyReasons, 'asking_prices_not_sales'],
      customerVisible: a.benchmark.customerDisplayAllowed,
    });
  } else if (!noMarket && !(a.market?.visible && a.market.context?.typical)) {
    claims.push({
      id: 'C_NOHIST',
      kind: 'missing_history',
      text: `We don't yet have enough comparable history for this event to say what's typical, so this is a current-market comparison only.`,
      values: { events: a.benchmark?.independentEventCount ?? 0 },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: null },
      evidenceIds: [],
      methodVersion: a.benchmark?.methodVersion ?? null,
      limitations: a.benchmark?.adequacyReasons ?? ['no_benchmark_run'],
      customerVisible: true,
    });
  }
  if (a.trend) {
    const w = a.trend.windows.h24 ?? a.trend.windows.h6 ?? a.trend.windows.h72;
    if (a.trend.adequacy === 'sufficient' && w) {
      const dirWord = a.trend.direction === 'down' ? 'fallen' : a.trend.direction === 'up' ? 'risen' : 'moved';
      const newSource = a.trend.floorLoweredByNewSource ? ' The lower price comes from a different seller, so this reflects a new cheaper option rather than existing sellers cutting prices.' : '';
      claims.push({
        id: 'C_TREND',
        kind: 'trend_change',
        text: `Your group's cheapest comparable option has ${dirWord} from ${formatUsd(w.baselineCents)} to ${formatUsd(w.currentCents)} over the last ${w.windowHours} hours (${a.trend.direction === 'flat' || a.trend.direction === 'mixed' ? 'no clear direction' : a.trend.direction}).${newSource} Past movement does not predict the next one.`,
        values: { baselineCents: w.baselineCents, currentCents: w.currentCents, windowHours: w.windowHours, direction: a.trend.direction },
        scope: { quantity: q, seatZone: null, feeBasis: 'verified_total', observedAt: obs },
        evidenceIds: a.trend.validObservationIds,
        methodVersion: a.trend.methodVersion,
        limitations: a.trend.qualityFlags,
        customerVisible: true,
      });
    } else {
      claims.push({
        id: 'C_NOTREND',
        kind: 'trend_change',
        text: `We have only ${a.trend.validObservationIds.length} comparable price observations over ${Math.round(a.trend.spanMinutes / 60)} hours for your group size, which isn't enough to call a trend.`,
        values: { observations: a.trend.validObservationIds.length, spanMinutes: a.trend.spanMinutes },
        scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
        evidenceIds: a.trend.validObservationIds,
        methodVersion: a.trend.methodVersion,
        limitations: a.trend.reasons,
        customerVisible: true,
      });
    }
  }
  if (a.independentOptionCount !== null && !noMarket) {
    claims.push({
      id: 'C_COUNT',
      kind: 'option_count',
      text: `${a.independentOptionCount} qualifying listing${a.independentOptionCount === 1 ? '' : 's'} for ${q} together among the sources we checked.`,
      values: { count: a.independentOptionCount },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['sources_checked_only'],
      customerVisible: true,
    });
  }
  const market = marketClaims(a, obs);
  claims.push(...market);
  const marketShown = market.some((c) => c.customerVisible);

  // What we checked, in the customer's terms. Sources we have no integration with are our business, not
  // theirs: they are listed for staff in the review console, never in the email. A source that should have
  // answered and failed (a timeout) is named, because it changes what the reply covers.
  const INTERNAL = ['not_integrated', 'not_supported', 'access_not_approved', 'not_configured', 'manual_only'];
  const failed = a.sourcesUnavailable.filter((s) => !INTERNAL.includes(s.status)).map((s) => s.sourceId);
  const unavailable = a.sourcesUnavailable.map((s) => `${s.sourceId} (${s.status.replace(/_/g, ' ')})`);
  claims.push({
    id: 'C_COVERAGE',
    kind: 'coverage',
    text: noMarket
      ? marketShown
        ? `The resale figures are market statistics from SeatData (StubHub and Vivid Seats listings, before fees), not specific tickets I’ve checked; prices can change quickly.`
        : `I can’t see live resale listings for this show yet, so this doesn’t compare other sellers’ prices.`
      : `Checked: ${a.sourcesChecked.join(', ')}.${failed.length ? ` Couldn’t reach: ${failed.join(', ')}.` : ''} Prices can change before checkout.`,
    values: { checked: a.sourcesChecked.length, unavailable: unavailable.length },
    scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
    evidenceIds: [],
    methodVersion: null,
    limitations: [],
    customerVisible: true,
  });
  if (a.policy.nextCheckpointAt) {
    claims.push({
      id: 'C_CHECKPOINT',
      kind: 'checkpoint',
      text: `Recheck point: ${a.policy.nextCheckpointAt.toISOString()}${a.policy.waitDeadlineAt ? `; decide by ${a.policy.waitDeadlineAt.toISOString()} at the latest` : ''}. ${a.policy.watchScheduled ? 'We will check for you and email if a qualifying offer appears.' : 'We are not monitoring this automatically; reply if you want us to.'}`,
      values: { nextCheckpointAt: a.policy.nextCheckpointAt.toISOString(), waitDeadlineAt: a.policy.waitDeadlineAt?.toISOString() ?? null, watchScheduled: a.policy.watchScheduled ? 1 : 0 },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: a.policy.policyVersion,
      limitations: a.policy.stopConditions,
      customerVisible: true,
    });
  }

  return {
    requestId: a.requestId,
    revision: a.revision,
    verifiedOfferObservationIds: [a.best, ...a.alternatives, a.entryReference].filter((e): e is Evaluated => !!e).map((e) => e.offer.id),
    basketKey: a.basketKey,
    basketVersion: 1,
    benchmarkRunId: a.benchmarkRunId,
    trendRunId: a.trendRunId,
    historicalAdequacy: a.benchmark?.adequacy ?? 'insufficient',
    trendAdequacy: a.trend?.adequacy ?? 'insufficient',
    customerPriorities: { ...a.priorities, decisionDeadline: a.priorities.decisionDeadline?.toISOString() ?? null },
    policyVersion: a.policy.policyVersion,
    decision: a.policy.decision,
    reasonCodes: a.policy.reasonCodes,
    abstentions: a.policy.abstentions,
    claimRecords: claims,
    evidenceExpiresAt: a.evidenceExpiresAt?.toISOString() ?? null,
    nextCheckpointAt: a.policy.nextCheckpointAt?.toISOString() ?? null,
    stopConditions: a.policy.stopConditions,
    watchConsentReference: a.watchConsentReference,
    isFixture: a.isFixture,
  };
}
