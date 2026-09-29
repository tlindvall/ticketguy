import { MARKET_RECENT_HOURS, basisSize, isGroupBasis, type MarketBasis, type MarketContext } from '@/lib/market/series';
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
export type ClaimKind = 'current_offer' | 'alternative_offer' | 'benchmark_range' | 'trend_change' | 'option_count' | 'coverage' | 'entry_reference' | 'checkpoint' | 'missing_history' | 'observation_time' | 'quoted_price' | 'face_value' | 'official_sale' | 'market_price' | 'market_benchmark' | 'market_supply' | 'market_read' | 'customer_link';

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
  /** Questions the email ends with, server-written from what we still don't know (never model-authored). */
  followUps?: string[];
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
  quote?: QuotedPrice | null;
  /**
   * Resale market statistics (DECISION_LOG #44): listed prices before fees, per ticket, never an offer.
   * `visible` is the licence's customer-display right; without it the claims are staff-only.
   */
  market?: { basis: MarketBasis | null; context: MarketContext | null; supply: MarketContext['supply']; supplyScope?: 'all' | 'group'; comparableLabel: string | null; visible: boolean } | null;
  /** A ticket-site link the customer sent (its marketplace name); we read the URL, never the page. */
  link?: { marketplace: string } | null;
};

/**
 * A price the customer is asking about, and where it came from. It is never a verified offer: a price they
 * typed, or what a listing showed when they copied or captured it. How it was worded (fees included or not,
 * per ticket or for the group) stays unknown unless the source says.
 */
export type QuotedPrice = {
  perTicketCents: number;
  /** They gave a number without saying per ticket or total; it was read as per ticket. */
  assumedPerTicket: boolean;
  source?: 'customer_reported' | 'listing_text' | 'screenshot';
  feeBasis?: 'all_in' | 'before_fees' | 'unknown';
  /** When the listing showed it (a screenshot's or pasted listing's time), when known. */
  seenAt?: Date | null;
  seller?: string | null;
};

/** "You mentioned $106 a ticket", or "The screenshot you sent shows $106 a ticket including fees on StubHub". */
function quoteLead(q: QuotedPrice): string {
  const fees = q.feeBasis === 'all_in' ? ' including fees' : q.feeBasis === 'before_fees' ? ' before fees' : '';
  const per = q.assumedPerTicket ? ' (I’ve taken that as per ticket)' : ' a ticket';
  const on = q.seller ? ` on ${q.seller}` : '';
  if (q.source === 'screenshot') return `The screenshot you sent shows ${formatUsd(q.perTicketCents)}${per}${fees}${on}. That’s what the listing showed when you took it; I haven’t checked that the seats are still there.`;
  if (q.source === 'listing_text') return `The listing you pasted shows ${formatUsd(q.perTicketCents)}${per}${fees}${on}. That’s what it said when you copied it; I haven’t checked that the seats are still there.`;
  return `You mentioned ${formatUsd(q.perTicketCents)}${per}${fees}.`;
}

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const countWord = (n: number) => COUNT_WORDS[n] ?? String(n);

/**
 * What the market figures mean for this customer, in one or two plain sentences: what a fair price is for
 * their group, and whether anything argues for moving quickly. It reads the calculated context only and
 * never says where prices will go.
 */
function marketRead(a: BuildPacketArgs): ClaimRecord | null {
  const m = a.market;
  const c = m?.context;
  if (!m || !c?.current) return null;
  const q = a.quantity;
  const group = q > 1 ? `for ${countWord(q)} together` : 'for one ticket';
  const floor = c.current.priceCents;
  const fairUpTo = roundToDollar(Math.round(floor * 1.15));
  const parts: string[] = [];
  // A price they asked about already has its own verdict (C_QUOTE_MARKET).
  if (!a.quote) parts.push(`For ${group.replace(/^for /, '')}, up to about ${formatUsd(fairUpTo)} a ticket before fees is a fair price; much more than that and you’re paying for a better section, not a better deal.`);
  const s = m.supply;
  if (s.trend === 'shrinking') parts.push('Listings for a group your size are thinning out, so if you find seats you like at a fair price, I wouldn’t wait.');
  else if (c.adequacy === 'sufficient' && c.direction === 'down') parts.push('Prices have been easing and there’s still plenty to choose from, so there’s no need to rush.');
  else if (c.adequacy === 'sufficient' && c.direction === 'up') parts.push('Prices have been climbing, so waiting hasn’t been paying off for this game.');
  else if (s.now !== null && s.now >= 50) parts.push('There’s plenty to choose from, so there’s no need to grab the first seats you see.');
  else if (s.now !== null && s.now < 15 && q > 1) parts.push('There aren’t many blocks for a group your size, so if you find seats you like at a fair price, I wouldn’t wait long.');
  if (!parts.length) return null;
  return {
    id: 'C_READ',
    kind: 'market_read',
    text: `My read: ${parts.join(' ').replace(/^./, (ch) => ch.toLowerCase())}`,
    values: { floorCents: floor, fairUpToCents: fairUpTo, direction: c.direction, supplyTrend: s.trend, listings: s.now },
    scope: { quantity: q, seatZone: c.zone, feeBasis: 'listed_before_fees', observedAt: c.current.at.toISOString() },
    evidenceIds: [],
    methodVersion: c.methodVersion ?? 'market-1.0',
    limitations: ['listed_prices_before_fees', 'market_statistics_not_listings', 'no_forecast'],
    customerVisible: m.visible,
  };
}

/** At most three questions, each one something that would change the answer and that we don't know yet. */
function followUpQuestions(a: BuildPacketArgs): string[] {
  const out: string[] = [];
  if (!a.quote && !a.best) {
    out.push(a.link
      ? `What price per ticket does that ${a.link.marketplace} listing show, and which section? I’ll tell you if it’s a good deal.`
      : 'Found seats you like? Send me the link, or the price and section, and I’ll tell you if it’s a good deal.');
  }
  if (a.priorities.budgetTotalCents === null && !a.quote) out.push('What’s the most you’d want to pay per ticket?');
  if (a.priorities.decisionDeadline === null && a.policy.decision !== 'buy_now') out.push('When do you need to have tickets sorted by?');
  return out.slice(0, 3);
}

/** Resale market claims. Every number is the calculated context's; wording says what the figure is and is not. */
function marketClaims(a: BuildPacketArgs, obs: string): ClaimRecord[] {
  const m = a.market;
  if (!m) return [];
  const out: ClaimRecord[] = [];
  const q = a.quantity;
  const c = m.context;
  const common = { evidenceIds: [], methodVersion: c?.methodVersion ?? 'market-1.0', customerVisible: m.visible };
  const group = isGroupBasis(m.basis) ? basisSize(m.basis!) : null;
  const size = m.basis ? basisSize(m.basis) : q;
  const moved = (s: MarketContext['supply']) => s.before !== null && s.hours !== null && s.trend !== 'stable' && s.trend !== 'unknown' ? `, ${s.trend === 'shrinking' ? 'down' : 'up'} from ${s.before} over the last ${s.hours} hours` : '';
  const supplyText = (s: MarketContext['supply']) =>
    s.now === null ? '' : group !== null && m.supplyScope === 'group' ? ` About ${s.now} listings have ${group} or more tickets${moved(s)}.` : ` About ${s.now} listings are up${moved(s)}.`;
  // A group's series starts at the first listings read, so its current floor is worth saying before there is a trend.
  const fresh = !!c?.current && !c.reasons.some((r) => r.startsWith('stale'));
  if (c && c.current && (c.adequacy === 'sufficient' || (group !== null && fresh))) {
    const what = m.basis === 'pair' ? 'for two tickets together' : group !== null ? `with ${group} or more tickets` : 'for a single ticket';
    // "Currently" only when the figure is recent; otherwise its age, so a day-old floor isn't passed off as now.
    const ageHours = Math.round((a.observedAt.getTime() - c.current.at.getTime()) / 3_600_000);
    const lead = ageHours < MARKET_RECENT_HOURS ? `Resale listings ${what} currently start at` : `As of about ${ageHours} hours ago, resale listings ${what} started at`;
    const w = c.adequacy === 'sufficient' ? (c.h72 ?? c.h24) : null;
    const when = w ? (w.hours >= 72 ? 'three days ago' : 'a day ago') : null;
    const move = !w || !when ? '' : c.direction === 'down' ? ` That’s down from ${formatUsd(w.fromCents)} ${when}.` : c.direction === 'up' ? ` That’s up from ${formatUsd(w.fromCents)} ${when}.` : ` About the same as ${when}.`;
    out.push({
      id: 'C_MARKET',
      kind: 'market_price',
      text: `${lead} ${formatUsd(c.current.priceCents)} a ticket (listed price, before fees).${move}${supplyText(m.supply)}${group !== null ? ` Some are bigger blocks that may not split into exactly ${q}.` : ''}`,
      values: { priceCents: c.current.priceCents, fromCents: w?.fromCents ?? null, windowHours: w?.hours ?? null, direction: c.direction, listings: m.supply.now, listingsBefore: m.supply.before },
      scope: { quantity: size, seatZone: c.zone, feeBasis: 'listed_before_fees', observedAt: c.current.at.toISOString() },
      limitations: ['listed_prices_before_fees', 'market_statistics_not_listings', 'past_movement_does_not_predict', ...(group !== null ? ['group_split_not_guaranteed'] : [])],
      ...common,
    });
    if (c.typical) {
      out.push({
        id: 'C_MARKET_TYPICAL',
        kind: 'market_benchmark',
        text: `For ${c.typical.events} past ${m.comparableLabel ?? 'comparable'} games at this venue, the cheapest listed ${m.basis === 'pair' ? 'price for two together' : 'ticket'} at this point before the game was typically ${formatUsd(c.typical.p25Cents)} to ${formatUsd(c.typical.p75Cents)} (median ${formatUsd(c.typical.medianCents)}).`,
        values: { events: c.typical.events, p25Cents: c.typical.p25Cents, medianCents: c.typical.medianCents, p75Cents: c.typical.p75Cents },
        scope: { quantity: size, seatZone: c.zone, feeBasis: 'listed_before_fees', observedAt: obs },
        limitations: ['listed_prices_before_fees', 'comparable_games_same_venue'],
        ...common,
      });
    }
    if (a.quote) {
      const listed = c.current.priceCents;
      // The floor is the cheapest listing anywhere in the venue, before fees; the quote is one listing, with fees
      // included or not. Under the floor is a reason to look closer, not a bargain.
      const floorText = `${formatUsd(listed)} before fees, anywhere in the venue${group !== null ? `, for ${group} or more tickets` : ''}`;
      const nearCap = Math.round(listed * (a.quote.feeBasis === 'before_fees' ? 1.15 : 1.3));
      const verdict = a.quote.perTicketCents < listed
        ? `below the cheapest resale listing I can see (${floorText}). That’s unusually low, so make sure the seats, the number of tickets and the fees are what you think before you pay`
        : a.quote.perTicketCents <= nearCap
          ? `close to the cheapest resale listing I can see (${floorText}${a.quote.feeBasis === 'before_fees' ? '' : ', and fees add to that'}), so it’s in line with the market for the cheapest seats`
          : `above the cheapest resale listing I can see (${floorText}). That can be fair for a better section, but it isn’t a bargain`;
      out.push({
        id: 'C_QUOTE_MARKET',
        kind: 'quoted_price',
        text: `Against resale: ${formatUsd(a.quote.perTicketCents)} a ticket is ${verdict}.`,
        values: { perTicketCents: a.quote.perTicketCents, listedCents: listed },
        scope: { quantity: size, seatZone: null, feeBasis: 'listed_before_fees', observedAt: c.current.at.toISOString() },
        limitations: ['listed_prices_before_fees', 'market_statistics_not_listings'],
        ...common,
      });
    }
  } else if ((m.basis === null || group !== null) && m.supply.now !== null && m.supplyScope !== 'group') {
    // Three or more before any listings read for the group: only the count of all listings, and said to be that.
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
    const face = a.faceValue;
    const range = face ? `${formatUsd(face.minCents)} to ${formatUsd(face.maxCents)} a ticket before fees` : null;
    // Face value is what the original seller charged: context for the price, never proof of a good deal. What
    // comparable seats cost now is the resale comparison (C_QUOTE_MARKET), when we have it.
    const marketShown = !!(a.market?.visible && a.market.context?.current);
    const noMarket = marketShown ? '' : ' I can’t see current resale prices for this show, so I can’t tell you whether that’s the going rate.';
    const verdictText = face
      ? {
          below: `That’s below the face value Ticketmaster lists (${range}). Face value is only what the original seller charged, not what seats are worth now, and a price under it can mean seats with a catch, so check the section, the view and any restrictions before you buy.`,
          within: `That’s within the face value Ticketmaster lists (${range}), so it isn’t above what the original seller charged. That says nothing about how good the seats are.`,
          fees: a.quote.feeBasis === 'before_fees'
            ? `That’s a little above the face value Ticketmaster lists (${range}), a small resale markup.`
            : `That’s a little above the face value Ticketmaster lists (${range}); fees alone can add that much, so it may be close to the original price all-in.`,
          markup: `That’s well above the face value Ticketmaster lists (${range}). That alone doesn’t make it a bad price: resale follows demand, so what matters is what comparable seats cost now.${noMarket}`,
        }[quoteVerdict(a.quote.perTicketCents, face)]
      : a.official
        ? `Ticketmaster doesn’t publish a price range for this show, so I can’t size that against face value. But if ${formatUsd(a.quote.perTicketCents)} is ${a.official.seller}’s own price, it’s face value, not a resale markup.`
        : `I can’t see what sellers are charging for this show yet, so I can’t say whether that’s low or high.`;
    claims.push({
      id: 'C_QUOTE',
      kind: 'quoted_price',
      text: `${quoteLead(a.quote)} ${verdictText}`,
      values: { perTicketCents: a.quote.perTicketCents, faceMinCents: face?.minCents ?? null, faceMaxCents: face?.maxCents ?? null, source: a.quote.source ?? 'customer_reported', feeBasis: a.quote.feeBasis ?? 'unknown' },
      scope: { quantity: q, seatZone: null, feeBasis: 'face_value_before_fees', observedAt: a.quote.seenAt?.toISOString() ?? obs },
      evidenceIds: [],
      methodVersion: 'quote-2.0',
      limitations: ['face_value_is_before_fees', 'not_a_verified_offer', 'face_value_is_context_not_value'],
      customerVisible: true,
    });
  } else if (a.faceValue) {
    claims.push({
      id: 'C_FACE',
      kind: 'face_value',
      text: `Ticketmaster lists face value for this show at ${formatUsd(a.faceValue.minCents)} to ${formatUsd(a.faceValue.maxCents)} a ticket before fees. That’s what the original seller charged, not what seats sell for now.`,
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
      // "Unless resale is cheaper" only when there is resale in the email to be cheaper; otherwise it reads as a hedge we can't back.
      text: a.best || (a.market?.visible && a.market.context?.current) ? `It’s still on general sale on ${a.official.seller}, which is where I’d buy unless a resale seat is clearly cheaper.` : `It’s on general sale on ${a.official.seller}, and that’s where I’d buy.`,
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
      text: `${small ? `Across a small sample of ${n}` : `Across ${n}`} comparable past events, the best ${q}-seat options we observed at a similar point before the event were ${small ? '' : 'typically '}${formatUsd(roundToDollar(perPersonCents(Math.round(a.benchmark.p25Cents), q)))} to ${formatUsd(roundToDollar(perPersonCents(Math.round(a.benchmark.p75Cents), q)))} per person (median ${formatUsd(roundToDollar(perPersonCents(Math.round(a.benchmark.medianCents), q)))}). These are observed asking prices, not sale prices.`,
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
  if (a.link) {
    claims.push({
      id: 'C_LINK',
      kind: 'customer_link',
      text: `Going by the ${a.link.marketplace} link you sent, here’s what I have for ${a.quantity > 1 ? `${countWord(a.quantity)} tickets` : 'one ticket'} to ${a.eventLabel}.`,
      values: { marketplace: a.link.marketplace },
      scope: { quantity: a.quantity, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['link_read_from_url_only'],
      customerVisible: true,
    });
  }
  const market = marketClaims(a, obs);
  claims.push(...market);
  const read = market.some((c) => c.id === 'C_MARKET' && c.kind === 'market_price') ? marketRead(a) : null;
  if (read) claims.push(read);
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
        ? `Those figures are StubHub and Vivid Seats resale prices before fees. They show where the market is, not seats I’ve checked, and they can move quickly.`
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
    followUps: followUpQuestions(a),
    evidenceExpiresAt: a.evidenceExpiresAt?.toISOString() ?? null,
    nextCheckpointAt: a.policy.nextCheckpointAt?.toISOString() ?? null,
    stopConditions: a.policy.stopConditions,
    watchConsentReference: a.watchConsentReference,
    isFixture: a.isFixture,
  };
}
