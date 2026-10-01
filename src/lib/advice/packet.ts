import { entryFailure, performanceFailure } from './concert-terms';
import { fromVenueMinutes, minutesOf, offerTotal, timeLabel, venueZoneName, type PartyTerms, type TextOffer } from './text-offers';
import { localStart } from '@/lib/domain/event-constraints';
import { MARKET_RECENT_HOURS, basisSize, isGroupBasis, type MarketBasis, type MarketContext } from '@/lib/market/series';
import { createHash } from 'node:crypto';
import { formatUsd, perPersonCents } from '@/lib/domain/money';
import type { BenchmarkResult } from './benchmark';
import type { TrendResult } from './trend';
import type { PolicyResult, CustomerPriorities } from './policy';
import type { Evaluated } from '@/lib/domain/comparison';
import type { ListingFields } from '@/lib/ai/listing-evidence';
import type { AlternativesResult } from '@/lib/market/alternatives';

/**
 * Typed evidence packet (API_AND_DATA_CONTRACTS §10). Every fact the customer sees is a server-rendered
 * claim with an ID, scope and allowed wording. The model may only reference claim IDs.
 */
export type ClaimKind = 'current_offer' | 'alternative_offer' | 'benchmark_range' | 'trend_change' | 'option_count' | 'coverage' | 'entry_reference' | 'checkpoint' | 'missing_history' | 'observation_time' | 'quoted_price' | 'face_value' | 'official_sale' | 'market_price' | 'market_benchmark' | 'market_supply' | 'market_read' | 'customer_link' | 'subject_listing' | 'catches' | 'verdict' | 'alternative_market';

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
  /** The same facts as `text`, one per bullet, for the email; `text` is what the model reads and cites. */
  items?: string[];
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
  /** What the email is about, in one line at the top: "Knicks vs. Celtics, Madison Square Garden, Oct 24 · 5 tickets". */
  headline?: string;
  evidenceExpiresAt: string | null;
  /** The occurrence this advice was written for; approval and send check the event still has it (R2-LIFECYCLE-01). */
  eventStartAt?: string | null;
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
  /** Every dataset behind the trend allows showing it to customers (R2-TREND-RIGHTS-01). Default: allowed. */
  trendDisplayAllowed?: boolean;
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
  /** The listing the customer showed us (screenshot or pasted text): what it displayed, never a verified offer. */
  subject?: SubjectListing | null;
  /** The event's own local date and start, to check the listing against. */
  eventLocalDate?: string | null;
  /**
   * Who and where the event is, to check the listing against (R2-IDENTITY-01): the performer or both teams with
   * their aliases (`names[0]` is the one said back), team nicknames ("Rangers"), the event's own name, and the
   * venue's names and city.
   */
  eventIdentity?: { names: string[]; nicknames: string[]; venueNames: string[]; city: string | null } | null;
  /** The event's start, to size delivery margins in its venue's zone. */
  eventStartAt?: Date | null;
  /** Whether the buyer said they need accessible seating. */
  accessibilityRequired?: boolean;
  /** The venue's time zone, for saying when something was checked. */
  timeZone?: string;
  /**
   * They asked us to watch prices: whether a watch is really running (a stored active watch whose alerts can be
   * sent), with its terms, or that nothing is being monitored. From stored state, never from wording (TG-B10).
   */
  /**
   * Cheaper offers the comparison rejected, and why: an obstructed view they ruled out, a bigger block that may
   * not sell as their number, accessible spaces they don't need, seats not together. Said so the customer knows
   * they weren't missed, and never offered as an alternative.
   */
  leftOut?: Array<{ reason: 'obstructed_view' | 'bigger_block' | 'accessible_only' | 'seats_not_together' | 'section_not_acceptable'; quantity: number }>;
  /**
   * Their hard requirements (seats together, the all-in budget, access, seat preference), when nothing verified
   * meets them: each is said as not yet checked, not implied by a market figure (audit replay A05-R1).
   */
  requirements?: string[];
  /**
   * The staffed comparison pilot has taken this request: a named owner will look for seats that meet the
   * requirements by hand and reply in the thread. Only set when that owner exists (DECISION_LOG #54).
   */
  staffFollowUp?: { hours: string } | null;
  /** Offers they laid out in their own words, two or more, compared as their question (retest R2-B02). */
  textOffers?: TextOffer[];
  /** What their offers are held to beyond access and budget, and the offer they asked to be compared against. */
  /** What they corrected about the listing we read earlier, said back first ("$72 a ticket is before fees"). */
  corrections?: string[];
  /** They restated the listing's numbers and they match what we read: said so, not "updated". */
  correctionMatches?: boolean;
  offerNeeds?: { noObstructed: boolean; togetherRequired: boolean; baseline: string | null; terms?: PartyTerms | null } | null;
  /** "game" for sports, "show" otherwise. */
  eventNoun?: 'game' | 'show';
  /** Questions they asked that aren't about price, answered first (TG-B02). */
  asks?: { deliveryRisk: boolean; accessibleSpaces: boolean; salesAsked?: boolean; parking?: { admissionEachCents: number | null; admissionAllIn: boolean } | null; gapAgainst?: { perTicketCents: number; beforeFees: boolean } | null } | null;
  /** They said the offer or screenshot is a made-up example: its facts, and no live-market or buying advice. */
  synthetic?: boolean;
  /** They asked whether to buy now or wait, or whether prices are trending (TGQA-R6 1011): answered first, or abstained. */
  trendAsked?: { noAlerts: boolean; riskOk: boolean } | null;
  /** Offers from earlier in the thread they've told us to ignore: the one left is judged alone (R05-F1). */
  offersSetAside?: string[];
  watchStatus?: { running: true; quantity: number; targetTotalCents: number; togetherRequired: boolean; expiresAt: Date } | { running: false } | null;
  /** Cheaper market listings around the customer's listing (market data, before fees, never verified offers). */
  marketAround?: AlternativesResult | null;
  /** They're travelling to it (a flight, a drive in): waiting is riskier for them than the market shows. */
  travelling?: boolean;
  /** Where they want to sit ("lower level"), when they said: a venue-wide figure doesn't describe those seats. */
  seatingPreference?: string | null;
};

export type SubjectListing = ListingFields & { source: 'screenshot' | 'listing_text'; observedAt: Date; confidence: 'high' | 'medium' | 'low' | null };

const shortDate = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));
/** "seats 7 to 10" for a run of four or more, otherwise "seats 7, 8 and 9". */
const seatList = (xs: string[]) => {
  const n = xs.map(Number);
  const run = n.length >= 4 && n.every((v, k) => Number.isInteger(v) && (k === 0 || v === n[k - 1]! + 1));
  return run ? `seats ${xs[0]} to ${xs[xs.length - 1]}` : `seat${xs.length === 1 ? '' : 's'} ${listJoin(xs)}`;
};
const listJoin = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "The listing shows 2 tickets in section 212, row D, seats 5 and 6, on StubHub, for $490 in total, delivered by Oct 3." */
function subjectClaim(a: BuildPacketArgs, sub: SubjectListing): ClaimRecord {
  const parts: string[] = [];
  if (sub.quantity) parts.push(`${sub.quantity} ticket${sub.quantity === 1 ? '' : 's'}`);
  const where = [sub.section ? `section ${sub.section}` : null, sub.row ? `row ${sub.row}` : null, sub.seatNumbers ? `seat${sub.seatNumbers.length === 1 ? '' : 's'} ${listJoin(sub.seatNumbers)}` : null].filter(Boolean);
  const bits = [parts.join(''), where.length ? `in ${where.join(', ')}` : null, sub.seller ? `on ${sub.seller}` : null, sub.wholePartyCents ? `for ${formatUsd(sub.wholePartyCents)} in total${sub.feeBasis === 'all_in' || (sub.perTicketCents !== null && sub.wholePartyCents > sub.perTicketCents * (sub.quantity ?? a.quantity) + 50) ? ' including fees' : ''}` : null, sub.deliveryText && DELIVERY_TIME.test(sub.deliveryText) ? `with delivery: ${sub.deliveryText.replace(/\.$/, '')}` : sub.deliveryBy ? `delivered by ${shortDate(sub.deliveryBy)}` : sub.deliveryText ? `with delivery: ${sub.deliveryText}` : null].filter(Boolean);
  const what = sub.source === 'screenshot' ? 'screenshot' : 'listing you pasted';
  // The price line (C_QUOTE) says when it was captured; without one, this does.
  const caveat = a.quote ? '' : ` That’s what it showed when you ${sub.source === 'screenshot' ? 'took it' : 'copied it'}; I haven’t checked the seats are still there.`;
  return {
    id: 'C_SUBJECT',
    kind: 'subject_listing',
    // After the price line (which names the source), this reads on from it rather than repeating "the listing shows".
    text: bits.length ? (a.quote ? `That’s ${bits.join(', ')}.` : `The ${what} shows ${bits.join(', ')}.${caveat}`) : `I couldn’t read the ticket details in the ${what}.${caveat}`,
    values: { quantity: sub.quantity, wholePartyCents: sub.wholePartyCents, section: sub.section, row: sub.row, source: sub.source },
    scope: { quantity: sub.quantity, seatZone: null, feeBasis: sub.feeBasis, observedAt: sub.observedAt.toISOString() },
    evidenceIds: [],
    methodVersion: 'listing-1.0',
    limitations: ['customer_supplied_evidence', 'not_a_verified_offer', 'availability_not_checked', 'authenticity_not_checked'],
    customerVisible: true,
  };
}

/** Lower case, no accents, punctuation or "the": "Beyoncé — The Renaissance Tour" → "beyonce renaissance tour". */
const fold = (x: string) => x.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\bthe\b/g, ' ').replace(/\s+/g, ' ').trim();
/** Whether one name contains the other as whole words; a short fragment ("NY") matches nothing. */
const sameName = (said: string, names: string[]) => {
  const a = fold(said);
  return a.length >= 3 && names.some((n) => {
    const b = fold(n);
    return b.length >= 3 && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `));
  });
};
/** The places a listing may name for a venue's city: "NYC" and the boroughs are New York, Inglewood is Los Angeles. */
const CITY_ALIASES: Record<string, string> = { nyc: 'new york', 'new york city': 'new york', manhattan: 'new york', brooklyn: 'new york', queens: 'new york', bronx: 'new york', 'staten island': 'new york', flushing: 'new york', la: 'los angeles', inglewood: 'los angeles', 'east rutherford': 'new york', elmont: 'new york', uniondale: 'new york', sf: 'san francisco', philly: 'philadelphia', dc: 'washington', 'washington dc': 'washington', 'washington d c': 'washington' };
const cityKey = (x: string) => {
  const f = fold(x.replace(/,.*$/, '')).replace(/\bsaint\b/g, 'st').replace(/\bfort\b/g, 'ft');
  return CITY_ALIASES[f] ?? f;
};

/** Where the listing names a different performer, city or venue than the event (R2-IDENTITY-01); null when it doesn't. */
function identityMismatch(a: BuildPacketArgs, sub: SubjectListing): { artist: string | null; city: string | null; venue: string | null } {
  const id = a.eventIdentity;
  if (!id) return { artist: null, city: null, venue: null };
  const artist = sub.eventName && id.names.length && !sameName(sub.eventName, [...id.names, ...id.nicknames]) ? id.names[0]! : null;
  const venue = sub.venue && id.venueNames.length && !sameName(sub.venue, id.venueNames) ? id.venueNames[0]! : null;
  // Not settled by a matching venue name: there's a Fillmore and a Paramount Theatre in many cities.
  const city = sub.city && id.city && cityKey(sub.city) !== cityKey(id.city) && !sameName(sub.city, [id.city]) ? id.city : null;
  return { artist, city, venue };
}

/**
 * The catches worth checking before paying, most material first, from what the listing showed and what it
 * didn't. Each is a fact about the listing or a gap in it; none is a verdict on the seller.
 */
export function listingCatches(a: BuildPacketArgs, sub: SubjectListing): string[] {
  const q = a.quantity;
  const out: string[] = [];
  // What's missing is a fact about what we were given, not about the listing: a detail left out of an email
  // may well be on the seller's page (TG-B08). A screenshot is closer to the page, and still only a crop of it.
  const missing = (what: string) => (sub.source === 'screenshot' ? `The screenshot doesn’t show ${what}` : `You haven’t included ${what}`);
  const wrong = identityMismatch(a, sub);
  const noun = a.eventNoun ?? 'game or show';
  if (wrong.artist) out.push(`The listing is for ${sub.eventName}, not ${wrong.artist}. Make sure it’s the right ${noun}.`);
  if (sub.eventDate && a.eventLocalDate && sub.eventDate !== a.eventLocalDate) out.push(`The date on the listing (${shortDate(sub.eventDate)}) isn’t the date I have for this event (${shortDate(a.eventLocalDate)}). Make sure it’s the right game or show.`);
  if (wrong.venue) out.push(`The listing says ${sub.venue}, but this ${a.eventNoun ?? 'event'} is at ${wrong.venue}. Make sure it’s the right ${noun}.`);
  if (wrong.city) out.push(`The listing says ${sub.city}, but this ${a.eventNoun ?? 'event'} is in ${wrong.city}. Make sure it’s the right ${noun}.`);
  if (sub.quantity && sub.quantity !== q) out.push(`It’s for ${sub.quantity} ticket${sub.quantity === 1 ? '' : 's'}, not the ${q} you asked about.`);
  const budget = a.priorities.budgetTotalCents;
  const totalHasFees = sub.wholePartyCents != null && sub.perTicketCents != null && sub.wholePartyCents > sub.perTicketCents * (sub.quantity ?? q) + 50;
  if (budget != null && sub.wholePartyCents != null && sub.wholePartyCents > budget) out.push(`At ${formatUsd(sub.wholePartyCents)} in total${sub.feeBasis === 'before_fees' && !totalHasFees ? ' before fees' : totalHasFees || sub.feeBasis === 'all_in' ? ' including fees' : ''}, it’s over your ${formatUsd(budget)} budget.`);
  if (sub.restrictionCodes.includes('accessible_seating') && !a.accessibilityRequired) out.push('These are accessible seats (wheelchair or companion spaces), meant for people who need them. If you don’t, pick other seats.');
  if (q > 1 && (sub.quantity ?? q) > 1) {
    if (sub.seatsTogether === false) out.push('It says the seats may not be together.');
    else if (sub.seatsTogether === null) out.push(`${missing('whether the seats are together')}. Check the listing before you buy if that matters.`);
  }
  if (sub.feeBasis === 'unknown') out.push(`${missing('whether fees are included')}, so check the total at checkout before you pay.`);
  else if (sub.feeBasis === 'before_fees') {
    // "$72 each + $48 per order = $264 total": the total it shows already carries the fees it lists (post-#54
    // A11), so "fees are extra" would contradict the total one line up.
    const n = sub.quantity ?? q;
    const over = sub.wholePartyCents != null && sub.perTicketCents != null ? sub.wholePartyCents - sub.perTicketCents * n : 0;
    out.push(over > 0
      ? `Its total, ${formatUsd(sub.wholePartyCents!)}, is ${formatUsd(over)} more than ${countWord(n)} at ${formatUsd(sub.perTicketCents!)}, so it looks like it includes the fees it lists. Check the checkout total matches before you pay.`
      : 'Fees are extra, so the total at checkout will be higher than the listed price.');
  }
  const byTime = sub.deliveryText ? DELIVERY_TIME.exec(sub.deliveryText)?.[1] ?? null : null;
  if (sub.deliveryBy && a.eventLocalDate && sub.deliveryBy >= a.eventLocalDate) {
    // The real margin, not "no time": "the latest promised transfer is 4pm, 3.5 hours before the 7:30pm start"
    // (TGQA-R8 S10). A deadline is a promise, not a delivery that has happened.
    const by = byTime ? minutesOf(byTime.replace(/\s+/g, '').toLowerCase()) : null;
    const start = a.eventStartAt && a.timeZone ? localStart(a.eventStartAt, a.timeZone).minutes : null;
    const gap = by !== null && start !== null && sub.deliveryBy === a.eventLocalDate ? start - by : null;
    const hours = gap !== null ? (gap % 60 === 0 ? `${gap / 60} hour${gap === 60 ? '' : 's'}` : `${Math.floor(gap / 60) ? `${(gap / 60).toFixed(1).replace(/\.0$/, '')} hours` : `${gap} minutes`}`) : null;
    out.push(gap !== null && gap > 0
      ? `The latest promised transfer is ${timeLabel(by!)} on ${shortDate(sub.deliveryBy)}, ${hours} before the ${timeLabel(start!)} start. That’s common for resale, but a late transfer would leave little room to sort it out.`
      : `The tickets are promised by ${byTime ? `${byTime.replace(/\s+/g, '').toLowerCase()} on ` : ''}${shortDate(sub.deliveryBy)}, the day of the event. That’s common for resale, but a late transfer would leave little room to sort it out.`);
  }
  else if (!sub.deliveryBy && !sub.deliveryText) out.push(`${missing('when the tickets will be delivered')}. Check the listing’s delivery date before you buy.`);
  if (sub.restrictionCodes.includes('obstructed_view')) out.push('It notes a limited or obstructed view.');
  if (sub.section && !sub.seatNumbers) out.push(`${missing('seat numbers')}. Check the listing if you want to know exactly where you’ll sit.`);
  const otherNotes = sub.restrictions.filter((r) => restrictionIsOther(r));
  if (otherNotes.length) out.push(`It also notes: ${listJoin(otherNotes.slice(0, 3))}.`);
  if (sub.includedBenefits.length) out.push(`It lists extras (${listJoin(sub.includedBenefits.slice(0, 3))}). Resale sellers can’t always pass those on, so confirm they’re included.`);
  if (sub.unreadable.length || sub.confidence === 'low') out.push(`I couldn’t read everything${sub.unreadable.length ? ` (${listJoin(sub.unreadable.slice(0, 2))})` : ''}, so check those details yourself.`);
  return out.slice(0, 5);
}

/** The reason not to buy a listing as it stands, when there is one: the wrong event, count, seats or budget. */
function hardProblem(a: BuildPacketArgs, sub: SubjectListing): string | null {
  const q = a.quantity;
  const artist = identityMismatch(a, sub).artist;
  if (artist) return `it’s for ${sub.eventName}, not ${artist}`;
  if (sub.eventDate && a.eventLocalDate && sub.eventDate !== a.eventLocalDate) return `the date on it (${shortDate(sub.eventDate)}) isn’t the event you asked about (${shortDate(a.eventLocalDate)})`;
  if (sub.quantity && sub.quantity < q) return `it’s for ${sub.quantity} ticket${sub.quantity === 1 ? '' : 's'}, and you need ${q}`;
  if (sub.restrictionCodes.includes('accessible_seating') && !a.accessibilityRequired) return 'these are accessible seats, meant for people who need them';
  if (sub.seatsTogether === false && a.priorities.togetherRequired) return 'it says the seats may not be together';
  const budget = a.priorities.budgetTotalCents;
  if (budget != null && sub.wholePartyCents != null && sub.wholePartyCents > budget) return `it’s over your ${formatUsd(budget)} budget`;
  return null;
}

/** Where the customer's price sits against the resale floor, when both are known: above or below, nothing more. */
export function priceAgainstFloor(q: QuotedPrice, floorCents: number): 'below' | 'above' {
  return q.perTicketCents < floorCents ? 'below' : 'above';
}

/**
 * The customer's price against the cheapest listing: the observed difference, its basis and what it can't say.
 * A venue-wide floor before fees values no particular seats, and a price with fees in it isn't the same basis,
 * so no percentage band turns the gap into "fair" or "in line" (TG-B04, remediation review §4).
 */
function floorComparison(q: QuotedPrice, floorCents: number): string {
  const gap = Math.abs(q.perTicketCents - floorCents);
  // Fees still to come on the floor listing move it up: an all-in price already below it only gets further
  // below; one above it gets closer (live A11 said "smaller" for a price already below).
  const basis = q.feeBasis === 'before_fees' ? '' : q.feeBasis === 'all_in' ? (q.perTicketCents < floorCents ? ' Your price includes fees and that one doesn’t, so once its fees are added the gap only gets larger.' : ' Your price includes fees and that one doesn’t, so after its fees the gap is smaller than that, and could close.') : ' I can’t tell whether your price includes fees, so the two aren’t on the same basis.';
  if (q.perTicketCents < floorCents) return `It’s ${formatUsd(gap)} a ticket below the cheapest listing I can see (${formatUsd(floorCents)} before fees). That’s unusual, so check the seats, the number of tickets and the fees before you pay.${basis}`;
  if (gap === 0) return `It’s the same as the cheapest listing I can see (${formatUsd(floorCents)} before fees).${basis}`;
  return `It’s ${formatUsd(gap)} a ticket above the cheapest listing I can see (${formatUsd(floorCents)} before fees).${basis} That cheapest listing could be any seat in the venue, so it doesn’t tell me what these seats are worth.`;
}

/**
 * The recommendation, first and in one or two sentences, for a listing the customer showed us. It follows from
 * the facts in the claims below it and never vouches for the seller, the seats or delivery.
 */
function verdictClaim(a: BuildPacketArgs, sub: SubjectListing): ClaimRecord {
  const q = a.quantity;
  const floor = a.market?.visible && a.market.context?.current ? a.market.context.current.priceCents : null;
  const alts = a.market?.visible ? (a.marketAround?.alternatives ?? []) : [];
  const verifiedCheaper = a.best && a.best.comparableTotalCents !== null && sub.wholePartyCents !== null && sub.feeBasis === 'all_in' && a.best.comparableTotalCents < sub.wholePartyCents ? sub.wholePartyCents - a.best.comparableTotalCents : null;
  const problem = hardProblem(a, sub);
  let text: string;
  let code: string;
  if (problem) {
    // The recommended option, when one is verified and fits: the suitable one, never merely the cheapest.
    const budget = a.priorities.budgetTotalCents;
    const fits = a.best && a.best.comparableTotalCents !== null && (budget == null || a.best.comparableTotalCents <= budget);
    const lessBy = fits && sub.wholePartyCents !== null && sub.feeBasis === 'all_in' && a.best!.comparableTotalCents! < sub.wholePartyCents ? ` and ${formatUsd(sub.wholePartyCents - a.best!.comparableTotalCents!)} less than this one` : '';
    text = `I wouldn’t buy this one as it stands: ${problem}.${fits ? ` The verified option below meets what you asked for${budget != null ? `: ${formatUsd(a.best!.comparableTotalCents!)} for ${q === 1 ? 'one' : `all ${QTY_WORDS_LOWER[q] ?? q}`}, within your ${formatUsd(budget)}` : ''}${lessBy}.` : ''}`;
    code = fits ? 'hard_problem_verified_fits' : 'hard_problem';
  } else if (verifiedCheaper) {
    text = `I’d look at the verified option below first: it’s ${formatUsd(verifiedCheaper)} less for ${q === 1 ? 'one ticket' : q === 2 ? 'both' : `all ${QTY_WORDS_LOWER[q] ?? q}`}.`;
    code = 'verified_cheaper';
  } else if (alts.length) {
    text = 'Before you buy it, have a look at the cheaper listings below.';
    code = 'market_cheaper';
  } else if (a.quote && floor !== null) {
    const where = priceAgainstFloor(a.quote, floor);
    text = `${floorComparison(a.quote, floor)}${where === 'above' && a.marketAround && a.marketAround.comparable > 0 ? ' I don’t see anything cheaper in your section or area.' : ''}`;
    code = `price_${where}`;
  } else {
    text = 'I can’t compare its price with the market yet, so the details below are what to check before you pay.';
    code = 'no_market';
  }
  return { id: 'C_VERDICT', kind: 'verdict', text, values: { code }, scope: { quantity: q, seatZone: null, feeBasis: sub.feeBasis, observedAt: sub.observedAt.toISOString() }, evidenceIds: [], methodVersion: 'listing-1.0', limitations: ['no_authenticity_or_delivery_guarantee'], customerVisible: true };
}

const QTY_WORDS_LOWER = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** Cheaper market listings, or that there are none, around the customer's listing. */
function alternativesClaim(a: BuildPacketArgs, alt: AlternativesResult): ClaimRecord {
  const q = a.quantity;
  const qw = QTY_WORDS_LOWER[q] ?? String(q);
  const lines = alt.alternatives.map(({ scope, listing }) => {
    const where = [listing.section ? `section ${listing.section}` : null, listing.row ? `row ${listing.row}` : null].filter(Boolean).join(', ');
    const scopeText = scope === 'same_section' ? 'in your section' : alt.zone ? `also in the ${alt.zone}` : 'in the same area';
    const subTotal = a.subject?.feeBasis === 'all_in' && a.subject.perTicketCents !== null ? a.subject.perTicketCents * q : null;
    const threshold = subTotal !== null ? ` (cheaper than yours only if its fees come to less than ${formatUsd(subTotal - listing.priceCents * q)} in total)` : '';
    return `${where || 'a listing'} at ${formatUsd(listing.priceCents)} a ticket before fees (about ${formatUsd(listing.priceCents * q)} for ${q === 1 ? 'one' : `all ${qw}`}), ${scopeText}${threshold}`;
  });
  const text = lines.length
    ? `Cheaper listings for ${q} or more together that I can see: ${lines.join('; and ')}. These are StubHub and Vivid Seats prices before fees, without a link, so search for them there.${a.subject?.feeBasis === 'before_fees' ? '' : ' Your price includes fees (or may), so after fees these may not be cheaper: compare the checkout totals.'} They aren’t your seats, and I haven’t checked they’re still for sale.`
    : alt.comparable > 0
      ? `Of the ${alt.comparable} listing${alt.comparable === 1 ? '' : 's'} I can see with ${q} or more tickets (bigger blocks may not split into exactly ${q}), none in your section or area is clearly cheaper than yours.`
      : `I can’t see other listings with ${q} or more tickets together for this event right now.`;
  return { id: 'C_ALTERNATIVES', kind: 'alternative_market', text, values: { comparable: alt.comparable, alternatives: alt.alternatives.length }, scope: { quantity: q, seatZone: alt.zone, feeBasis: 'listed_before_fees', observedAt: a.observedAt.toISOString() }, evidenceIds: [], methodVersion: 'alternatives-1.0', limitations: ['market_statistics_not_listings', 'listed_prices_before_fees', 'not_verified_offers', 'not_same_seats'], customerVisible: !!a.market?.visible };
}

/** Whether we have a verified alternative (checked by a person or a licensed source, all-in total), said plainly. */
function verifiedClaim(a: BuildPacketArgs, sub: SubjectListing): ClaimRecord | null {
  if (a.best) return null; // C_BEST names it, with its link
  // No source searched and no market shown: the verdict already says it can't be compared yet (TGQA-R8 S10).
  if (!a.sourcesChecked.length && !a.market?.visible) return null;
  return { id: 'C_VERIFIED', kind: 'coverage', text: 'I haven’t found a verified alternative I can link you to yet, with a checked all-in price.', values: {}, scope: { quantity: a.quantity, seatZone: null, feeBasis: null, observedAt: sub.observedAt.toISOString() }, evidenceIds: [], methodVersion: null, limitations: ['no_verified_inventory'], customerVisible: true };
}

const restrictionIsOther = (r: string) => !/\b(wheelchair|accessible|accessibility|ada|companion|obstructed|limited|partial|restricted|side view|vip|hospitality|package)\b/i.test(r);

function catchesClaim(a: BuildPacketArgs, sub: SubjectListing): ClaimRecord | null {
  const items = listingCatches(a, sub);
  if (!items.length) return null;
  return {
    id: 'C_CATCHES',
    kind: 'catches',
    text: items.join('\n'),
    values: { count: items.length },
    scope: { quantity: a.quantity, seatZone: null, feeBasis: sub.feeBasis, observedAt: sub.observedAt.toISOString() },
    evidenceIds: [],
    methodVersion: 'listing-1.0',
    limitations: ['customer_supplied_evidence'],
    customerVisible: true,
  };
}

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
  /**
   * The listing's own breakdown when its total carries fees on top of a before-fees ticket price ("$72 each +
   * $48 per order = $264"): the quote is then the all-in share per ticket, and this is what it's made of.
   */
  base?: { perTicketCents: number; feesCents: number; tickets: number; totalCents: number } | null;
  /** When the listing showed it (a screenshot's or pasted listing's time), when known. */
  seenAt?: Date | null;
  seller?: string | null;
};

/** "You mentioned $106 a ticket", or "The screenshot you sent shows $106 a ticket including fees on StubHub". */
function quoteLead(q: QuotedPrice): string {
  const on = q.seller ? ` on ${q.seller}` : '';
  if (q.base && (q.source === 'screenshot' || q.source === 'listing_text')) {
    const b = q.base;
    const what = `${formatUsd(b.perTicketCents)} a ticket before fees, plus ${formatUsd(b.feesCents)} in fees for the order: ${formatUsd(b.totalCents)} for ${countWord(b.tickets)}, which is ${formatUsd(q.perTicketCents)} each including fees${on}`;
    return q.source === 'screenshot' ? `The screenshot you sent shows ${what}. That’s what the listing showed when you took it; I haven’t checked that the seats are still there.` : `The listing you pasted shows ${what}. That’s what it said when you copied it; I haven’t checked that the seats are still there.`;
  }
  const fees = q.feeBasis === 'all_in' ? ' including fees' : q.feeBasis === 'before_fees' ? ' before fees' : '';
  const per = q.assumedPerTicket ? ' (I’ve taken that as per ticket)' : ' a ticket';
  if (q.source === 'screenshot') return `The screenshot you sent shows ${formatUsd(q.perTicketCents)}${per}${fees}${on}. That’s what the listing showed when you took it; I haven’t checked that the seats are still there.`;
  if (q.source === 'listing_text') return `The listing you pasted shows ${formatUsd(q.perTicketCents)}${per}${fees}${on}. That’s what it said when you copied it; I haven’t checked that the seats are still there.`;
  return `You mentioned ${formatUsd(q.perTicketCents)}${per}${fees}.`;
}

/** A delivery line that names the time ("Mobile transfer, delivery by 6pm on game day"): shown as the time, not just the date. */
const DELIVERY_TIME = /\b(?:by|before|at)\s+(noon|midday|\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i;

/** "Sep 22, 11:00 AM EDT": when a price was checked, in the venue's time. */
export function checkedAt(d: Date, timeZone = 'America/New_York'): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const countWord = (n: number) => COUNT_WORDS[n] ?? String(n);

/**
 * What the market figures mean for this customer, in one or two plain sentences: what a fair price is for
 * their group, and whether anything argues for moving quickly. It reads the calculated context only and
 * never says where prices will go.
 */
/** Fewer listings than this for their group size is thin supply, said as a caution. */
const SUPPLY_ADEQUATE_MIN = 15;

function marketRead(a: BuildPacketArgs): ClaimRecord | null {
  const m = a.market;
  const c = m?.context;
  if (!m || !c?.current) return null;
  const q = a.quantity;
  const floor = c.current.priceCents;
  const parts: string[] = [];
  // The floor is the cheapest listing anywhere in the venue, before fees: where the market starts, never what
  // particular seats are worth (TG-B04). What the customer can afford is a separate question, answered against
  // their whole-party budget with the fee basis said, never by calling a floor-plus-markup "fair" (TG-B03).
  if (!a.quote) {
    const budget = a.priorities.budgetTotalCents;
    const ageHours = Math.round((a.observedAt.getTime() - c.current.at.getTime()) / 3_600_000);
    // Every floor carries when it was seen, and never reads as a minimum for the whole market (post-#54 QA,
    // R3-B06): it is the lowest asking price in the sources we read, at that time, for that group size.
    const when = ` (checked ${checkedAt(c.current.at, a.timeZone)}${ageHours >= MARKET_RECENT_HOURS ? `, about ${ageHours} hours ago` : ''})`;
    const party = q > 1 ? ` for ${countWord(q)}` : '';
    const groupFloor = floor * q;
    const where = isGroupBasis(m.basis) ? `listings with ${basisSize(m.basis!)} or more tickets` : m.basis === 'pair' ? 'listings for two together' : 'single tickets';
    if (budget != null && groupFloor > budget) {
      // A floor times their number is what that price would come to, not a sellable offer for exactly them, and
      // one sampled floor over the cap doesn't prove the whole market is (remediation review §3).
      parts.push(`Your budget is ${formatUsd(budget)}${party}${q > 1 ? ` (${formatUsd(Math.floor(budget / q))} a ticket)` : ''}. The cheapest ${where} I saw${when} were ${formatUsd(floor)} a ticket before fees; ${q > 1 ? `${countWord(q)} at that price would be ${formatUsd(groupFloor)}` : 'that'}, over your budget before any fees. That doesn’t prove nothing cheaper exists now, but I haven’t seen anything within it.`);
    } else if (budget != null) {
      const room = budget - groupFloor;
      parts.push(`The cheapest ${where} I saw${when} were ${formatUsd(floor)} a ticket before fees; ${q > 1 ? `${countWord(q)} at that price would be ${formatUsd(groupFloor)}` : 'that'}, which leaves ${formatUsd(room)} of your ${formatUsd(budget)} for fees. I can’t see those fees, so whether it fits is unconfirmed until you see the checkout total.`);
    } else {
      parts.push(`The lowest asking price I saw among ${where}${when} was ${formatUsd(floor)} a ticket before fees${q > 1 ? `, ${formatUsd(groupFloor)}${party}` : ''}, anywhere in the venue. That’s where those listings started when I looked, on StubHub and Vivid Seats only, not what particular seats are worth; fees come on top, and it can move either way.`);
    }
  }
  const s = m.supply;
  // Timing is said only from a fresh series for this group size, for the seats they asked about, and waiting
  // is suggested only to someone who has said they can take the risk and by when they must decide. Otherwise
  // it says plainly that the evidence doesn't settle it.
  const fresh = !c.reasons.some((r) => r.startsWith('stale'));
  // Their question was delivery, or which of their offers: a buy-or-wait passage only distracts from it, and
  // their departure time is already the deadline that matters (post-#54 QA, R3-B03).
  if (a.asks?.deliveryRisk || (a.textOffers && a.textOffers.length >= 2)) {
    if (!parts.length) return null;
    return readClaim(a, parts, c, s);
  }
  const trendKnown = fresh && c.adequacy === 'sufficient' && !a.seatingPreference;
  const p = a.priorities;
  const canWait = !a.travelling && p.mustAttend !== true && (p.waitRiskTolerance === 'medium' || p.waitRiskTolerance === 'high') && p.decisionDeadline !== null;
  // Scarcity for their group only from counts for their group size, never from all-event listing counts (R4-B07).
  const groupCounts = m.supplyScope === 'group';
  // Falling prices say nothing about how much there is to choose from (R2-SUPPLY-COPY-01): reassurance about
  // waiting needs a known, adequate count for their group size, read fresh. Unknown supply is said as unknown,
  // and a thin count is a caution whichever way prices are moving.
  const supplyKnown = fresh && s.now !== null && (groupCounts || q === 1);
  const thin = supplyKnown && s.now! < SUPPLY_ADEQUATE_MIN && (q > 1 || s.now! <= 1);
  const listingsWord = (n: number) => `${n} listing${n === 1 ? '' : 's'}`;
  const deadline = p.decisionDeadline ? ` by ${checkedAt(p.decisionDeadline, a.timeZone).replace(/,? \d{1,2}:\d{2} [AP]M [A-Z]{2,5}$/, '')}` : '';
  if (fresh && groupCounts && s.trend === 'shrinking') parts.push('Listings for a group your size are thinning out, so if you find seats that meet what you need at a price you’re happy with, I wouldn’t wait.');
  else if (thin) parts.push(`${trendKnown && c.direction === 'down' ? 'Prices have been easing, but there' : 'There'} ${s.now === 1 ? 'was only 1 listing' : `were only ${listingsWord(s.now!)}`} ${q > 1 ? `with ${countWord(q)} or more tickets` : ''} when I checked, so I wouldn’t count on waiting: if you find seats that meet what you need at a price you’re happy with, I wouldn’t hold out.`.replace(/ {2,}/g, ' '));
  else if (trendKnown && c.direction === 'down') {
    if (a.travelling || p.mustAttend === true) parts.push('Prices have been easing, but since you can’t risk missing it, I wouldn’t hold out for a lower price.');
    else if (canWait && supplyKnown) parts.push(`Prices have been easing, and there were ${listingsWord(s.now!)}${q > 1 ? ` with ${countWord(q)} or more tickets` : ''} when I checked${q > 1 ? ' (some may not split into exactly your number or sit together)' : ''}. Waiting${deadline} is reasonable if you’re ok with the risk that the seats you want go; it isn’t a promise prices keep falling.`);
    else if (canWait) parts.push(`Prices have been easing, but I can’t see how many listings there are for a group your size, so that alone isn’t a reason to wait. If you do wait, it’s a risk that the seats you want go${deadline ? `, and I’d decide${deadline}` : ''}.`);
    else parts.push('Prices have been easing, but that doesn’t tell me they’ll keep falling. Whether waiting is worth it depends on when you need to decide and how much you’d mind missing out, which I don’t know yet.');
  } else if (trendKnown && c.direction === 'up') parts.push(`Prices have been climbing, so waiting hasn’t been paying off for this ${a.eventNoun ?? 'game'}.`);
  else if (!trendKnown && !a.quote) parts.push('There isn’t enough recent history for your group and seats to say whether waiting would help.');
  if (!parts.length) return null;
  return readClaim(a, parts, c, s);
}

function readClaim(a: BuildPacketArgs, parts: string[], c: MarketContext, s: MarketContext['supply']): ClaimRecord {
  return {
    id: 'C_READ',
    kind: 'market_read',
    text: `My read: ${parts.join(' ').replace(/^./, (ch) => ch.toLowerCase())}`,
    values: { floorCents: c.current!.priceCents, budgetTotalCents: a.priorities.budgetTotalCents ?? null, direction: c.direction, supplyTrend: s.trend, listings: s.now },
    scope: { quantity: a.quantity, seatZone: c.zone, feeBasis: 'listed_before_fees', observedAt: c.current!.at.toISOString() },
    evidenceIds: [],
    methodVersion: c.methodVersion ?? 'market-1.0',
    limitations: ['listed_prices_before_fees', 'market_statistics_not_listings', 'no_forecast'],
    customerVisible: a.market!.visible,
  };
}

/** At most three questions, each one something that would change the answer and that we don't know yet. */
function followUpQuestions(a: BuildPacketArgs): string[] {
  const out: string[] = [];
  const sub = a.subject ?? null;
  if (!a.quote && !a.best && !sub && !a.staffFollowUp && !(a.textOffers && a.textOffers.length >= 2)) {
    // We never open marketplace pages, so a link tells us the event and nothing about the seats or price.
    out.push(a.link
      ? `I can’t open ${a.link.marketplace} listings myself. Could you send a screenshot of it (price, section, row and delivery date), or tell me the price and section?`
      : 'Found seats you like? Send me the link and a screenshot, or the price and section, and I’ll check it.');
  }
  // A price we had to read as per ticket is asked about, because the answer changes the whole comparison.
  if (a.quote?.assumedPerTicket && a.quantity > 1 && (a.quote.source === 'screenshot' || a.quote.source === 'listing_text')) out.push(`Is ${formatUsd(a.quote.perTicketCents)} the price per ticket, or for all ${a.quantity}?`);
  // Only what would change the answer: a budget when we're finding options, and the timing questions when the
  // market could make waiting worth it or the policy needs them.
  const askBudget = a.priorities.budgetTotalCents === null && !a.quote && !sub && !(a.textOffers && a.textOffers.length >= 2);
  // Timing questions only when timing is the open question: not over a delivery or offer question they asked,
  // whose own deadline (a noon departure) is already the one that matters (retest R2-B04).
  const askedOther = !!(a.asks?.deliveryRisk || a.asks?.accessibleSpaces || (a.textOffers && a.textOffers.length >= 2));
  const timingMatters = !askedOther && (a.policy.clarificationNeeded?.length || (a.market?.visible && a.market.context?.adequacy === 'sufficient' && a.market.context.direction === 'down'));
  if (timingMatters && a.priorities.decisionDeadline === null && a.policy.decision !== 'buy_now') out.push('When do you need to have tickets sorted by?');
  if (timingMatters && a.priorities.mustAttend === null && a.priorities.waitRiskTolerance === null && !a.travelling && a.policy.decision !== 'buy_now') out.push('Would you rather lock in seats now, or wait for a better price and accept you might miss out?');
  if (askBudget) out.push('What’s the most you’d want to pay per ticket?');
  return out.slice(0, 3);
}

/** "No obstructed views" is their words; the figures cover every seat in the venue, and say so. */
function wholeVenue(pref: string | null): string {
  const p = pref?.trim().replace(/[.!]+$/, '');
  return p ? ` These cover every seat in the venue, so they don’t reflect your preference (“${p.replace(/^./, (ch) => ch.toLowerCase())}”).` : '';
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
    s.now === null ? '' : group !== null && m.supplyScope === 'group' ? ` About ${s.now} listing${s.now === 1 ? ' has' : 's have'} ${group} or more tickets${moved(s)}.` : ` About ${s.now} listing${s.now === 1 ? ' is' : 's are'} up${moved(s)}.`;
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
      text: `${lead} ${formatUsd(c.current.priceCents)} a ticket (listed price, before fees).${move}${supplyText(m.supply)}${group !== null ? ` Some are bigger blocks that may not split into exactly ${q}.` : ''}${wholeVenue(a.seatingPreference ?? null)}`,
      items: [
        `Lowest asking price${group !== null ? ` with ${group} or more tickets` : m.basis === 'pair' ? ' for two together' : ''}, checked ${checkedAt(c.current.at, a.timeZone)}${ageHours < MARKET_RECENT_HOURS ? '' : ` (about ${ageHours} hours ago)`}: ${formatUsd(c.current.priceCents)} a ticket before fees${q > 1 ? ` (about ${formatUsd(roundToDollar(c.current.priceCents * q))} for ${countWord(q)})` : ''}.${move}`,
        ...(m.supply.now !== null
          ? [group !== null && m.supplyScope === 'group' ? `${supplyText(m.supply).trim()} Some are bigger blocks that may not split into exactly ${q}.` : `About ${m.supply.now} resale listings in all${moved(m.supply)}.`]
          : []),
        ...(a.seatingPreference ? [wholeVenue(a.seatingPreference ?? null).trim()] : []),
      ],
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
      out.push({
        id: 'C_QUOTE_MARKET',
        kind: 'quoted_price',
        text: `Against resale${group !== null ? ` (listings with ${group} or more tickets)` : ''}: ${floorComparison(a.quote, listed)}`,
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
      text: `There are about ${m.supply.now} resale listings for this ${a.eventNoun ?? 'game'}${m.supply.before !== null && m.supply.hours !== null && m.supply.trend !== 'stable' && m.supply.trend !== 'unknown' ? `, ${m.supply.trend === 'shrinking' ? 'down' : 'up'} from ${m.supply.before} over the last ${m.supply.hours} hours` : ''}. That counts all listings, not blocks of ${q} seats together.`,
      values: { listings: m.supply.now, listingsBefore: m.supply.before, trend: m.supply.trend },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      limitations: ['all_listings_not_group_blocks'],
      ...common,
    });
  }
  return out;
}

/**
 * Their offers, side by side, as their question. One record per offer; the whole-party total worked out once
 * (per-ticket times the tickets they'd buy, plus a per-order fee once). Every hard requirement they gave is
 * applied to every offer before any price is compared: how many can go and whether they'll buy extra, a block
 * that won't split, the view, access, together, the time the tickets must arrive, and the budget. An offer whose
 * fees aren't known yet is neither a fit nor ruled out: it is compared by the fee that would make it cheaper
 * (break-even), never called a fit (post-#55 live QA, R4-B01/B02/B03). When nothing fits, the one change that
 * would make an offer work is named. Their notes, not listings we've seen, so the pick is conditional on what
 * they copied and nothing is called a good price.
 */
type OfferVerdict = { o: TextOffer; tot: ReturnType<typeof offerTotal>; why: Array<{ kind: 'admission' | 'performance' | 'entry' | 'availability' | 'day' | 'transfer' | 'access' | 'short' | 'block' | 'extra' | 'view' | 'together' | 'budget' | 'late' | 'no_time'; text: string }>; feesUnknown: boolean };

/**
 * Their offers compared without an event on file (TGQA-R6 1006): the arithmetic and the hard rules need only what
 * they sent, so "which date?" never stands between them and the answer. Same engine as the full reply.
 */
export function suppliedOffersAnswer(a: { offers: TextOffer[]; quantity: number; budgetTotalCents: number | null; needs: NonNullable<BuildPacketArgs['offerNeeds']>; accessibilityRequired: boolean; timeZone: string; offersSetAside?: string[]; observedAt: Date; before?: OffersBefore | null }): { lead: string; items: string[] } {
  const c = offersClaim({ quantity: a.quantity, priorities: { budgetTotalCents: a.budgetTotalCents }, offerNeeds: a.needs, accessibilityRequired: a.accessibilityRequired, timeZone: a.timeZone, offersSetAside: a.offersSetAside, observedAt: a.observedAt } as unknown as BuildPacketArgs, a.offers, a.before ?? null);
  return { lead: c.text.split('\n')[0]!, items: c.items ?? [] };
}

/** What their terms were before this message: a changed count, budget or priority explains a changed pick. */
type OffersBefore = { quantity: number | null; owned?: number | null; priority: PartyTerms['priority'] | null; budgetTotalCents: number | null };

function offersClaim(a: BuildPacketArgs, offers: TextOffer[], before: OffersBefore | null = null): ClaimRecord {
  const need = a.offerNeeds ?? { noObstructed: false, togetherRequired: false, baseline: null, terms: null };
  const terms = need.terms ?? { attendees: null, extra: null, maxBuy: null, deadlineMinutes: null, seating: null };
  // How many are going, which is not always how many they'd buy ("happy to buy six; only five of us"), and less
  // any ticket someone already holds: the purchase is the new admissions only (R1-M02).
  const owned = terms.owned ?? 0;
  const q = terms.toBuy ?? terms.attendees ?? a.quantity;
  // "Offer B" / "the green listing" as named; mid-sentence, a lettered offer is just its letter ("B costs less").
  const Name = (o: TextOffer) => o.name.charAt(0).toUpperCase() + o.name.slice(1);
  const short = (o: TextOffer) => (/^[A-Z1-9]$/.test(o.label) ? o.label : o.name);
  // Times said in the venue's own zone, and in theirs when they wrote another ("1:30pm New York time (10:30am Los Angeles time)").
  // Also when their deadline is in another zone than the venue's: "11am Los Angeles time" beside a New York deadline.
  const zoned = offers.some((o) => o.deliveryAsWritten) || (!!terms.deadlineZone && terms.deadlineZone !== venueZoneName(a.timeZone ?? 'America/New_York'));
  const zoneName = zoned ? venueZoneName(a.timeZone ?? 'America/New_York') : null;
  const at = (m: number) => `${timeLabel(m)}${zoneName ? ` ${zoneName} time` : ''}`;
  const partyOf = (n: number) => (n === 1 ? 'one' : n === 2 ? 'both' : `all ${countWord(n)}`);
  const ticketsWord = (n: number) => (n === q ? (owned ? `the ${n === 1 ? 'new ticket' : `${countWord(n)} new tickets`}` : partyOf(n)) : `${countWord(n)} tickets`);
  const budget = a.priorities.budgetTotalCents ?? null;
  const statedCharges = (o: TextOffer) => o.orderFeeCents !== null || o.perTicketFeeCents !== null;
  // A subtotal already includes any charges they supplied. Only the remaining fees are unknown.
  const unknownFees = (o: TextOffer) => statedCharges(o) ? 'remaining fees' : 'fees';
  const deadline = terms.deadlineMinutes ?? terms.performanceStartMinutes ?? null;
  const tz = a.timeZone ?? 'America/New_York';
  // Their deadline, in the zone they wrote it in: "your 1pm New York deadline".
  // Only when it differs from the venue's does the zone need saying; "your noon deadline" is clear on its own.
  const otherZone = !!terms.deadlineZone && terms.deadlineZone !== venueZoneName(tz);
  const dl = (m: number) => (otherZone ? `${timeLabel(fromVenueMinutes(m, terms.deadlineZone!, tz))} ${terms.deadlineZone}` : at(m));
  // One fixed basket ("a fixed bundle of two admissions") is said as that, not as stock and a per-package count.
  const oneBasket = (o: TextOffer) => o.productKind === 'package' && o.unitsAvailable === 1 && o.admissionsPerUnit != null;
  // A bundle that doesn't say how many it admits, priced as the bundle ("a bundle of admissions for $180"): its price
  // is the bundle's, never a per-person price to multiply, and it covers nobody until its count is known (R1-M02).
  const unknownCapacity = (o: TextOffer) => o.productKind === 'package' && o.quantity === null && o.admissionsPerUnit == null && !(o.perTicketCents !== null && o.priceBasisStated);
  const price = (o: TextOffer, tot: ReturnType<typeof offerTotal>) => {
    const fees = o.feeBasis === 'all_in' ? ' including fees' : o.feeBasis === 'before_fees' ? ' before fees' : '';
    if (o.totalCents === null && o.perTicketCents === null) return 'price not stated';
    if (unknownCapacity(o)) return `${formatUsd((o.totalCents ?? o.perTicketCents)!)} for the bundle${fees}; how many it admits isn’t stated`;
    if (o.totalCents !== null && !tot) return oneBasket(o) ? `${formatUsd(o.totalCents)} for the bundle${fees}` : `${formatUsd(o.totalCents)} per quoted package${fees}; insufficient package stock for your party`;
    if (o.totalCents !== null) return `${formatUsd(o.totalCents)} in total${fees}${o.orderFeeCents !== null || o.perTicketFeeCents !== null ? `, plus ${[o.orderFeeCents !== null ? `${formatUsd(o.orderFeeCents)} for the order` : '', o.perTicketFeeCents !== null ? `${formatUsd(o.perTicketFeeCents)} per ticket` : ''].filter(Boolean).join(' and ')} = ${formatUsd(tot!.cents)}` : ''}${tot && tot.tickets !== q ? ` for ${countWord(tot.tickets)} tickets` : ''}`;
    const packageUnits = o.productKind === 'package' && o.admissionsPerUnit != null;
    const each = `${formatUsd(o.perTicketCents!)} ${packageUnits ? 'per package' : 'each'}${o.perTicketFeeCents ? '' : fees}`;
    if (!tot) return packageUnits && oneBasket(o) ? `${formatUsd(o.perTicketCents!)} for the bundle${fees}` : each;
    // Every fee they gave is in the working, not only in the total: "$52.50 each, plus $12.75 a ticket in fees and
    // $8 for the whole order: $269" (live V04 showed the $8 and hid the $12.75).
    const extras = [o.perTicketFeeCents ? `${formatUsd(o.perTicketFeeCents)} a ticket in fees` : null, o.orderFeeCents !== null ? `${formatUsd(o.orderFeeCents)} for the whole order` : null].filter(Boolean);
    if (extras.length) return `${each}, plus ${extras.join(' and ')}: ${formatUsd(tot.cents)}${tot.allIn ? ' in total' : ''} for ${ticketsWord(tot.tickets)}`;
    if (packageUnits && oneBasket(o)) return `${formatUsd(tot.cents)} for the bundle${fees}`;
    if (packageUnits) return `${each}, ${formatUsd(tot.cents)} for ${countWord(Math.ceil(tot.tickets / o.admissionsPerUnit!))} ${Math.ceil(tot.tickets / o.admissionsPerUnit!) === 1 ? 'package' : 'packages'} admitting ${ticketsWord(tot.tickets)}`;
    return tot.tickets > 1 ? `${each}, ${formatUsd(tot.cents)} for ${ticketsWord(tot.tickets)}${o.feeBasis === 'before_fees' ? ' plus fees' : ''}` : each;
  };
  const describe = (o: TextOffer) => oneBasket(o)
    ? [`a fixed bundle of ${countWord(o.admissionsPerUnit!)} ${o.admissionsPerUnit === 1 ? 'admission' : 'admissions'}`, o.together ? 'together' : o.together === false ? 'not together' : null, o.tier ?? null].filter(Boolean).join(', ')
    : [o.productKind === 'package' && o.admissionsPerUnit != null ? `${o.unitsAvailable != null ? `${countWord(o.unitsAvailable)} ${o.unitsAvailable === 1 ? 'package' : 'packages'} available, ` : ''}${countWord(o.admissionsPerUnit)} ${o.admissionsPerUnit === 1 ? 'admission' : 'admissions'} per package` : o.quantity !== null ? `${countWord(o.quantity)}${o.together ? ' together' : ''}` : null, o.productKind && o.productKind !== 'unknown' ? (o.productKind === 'admission' ? 'concert admission' : o.productKind) : o.accessible ? 'wheelchair-accessible spaces' : o.admission === 'excluded' ? 'no admission' : terms.concertAdmission && o.admission !== 'included' ? 'admission unverified' : o.quantity === null ? 'ordinary seats' : null, o.quantity === null && o.together ? 'together' : null, o.pairs ? 'two adjacent pairs' : o.together === false ? 'not together' : null, o.obstructed === true ? 'obstructed view' : o.obstructed === false ? 'unobstructed' : null, o.mustBuyAll ? 'can’t be split' : null, o.deliveryMinutes === 0 ? 'immediate transfer' : o.deliveryMinutes !== null ? `delivery by ${at(o.deliveryMinutes)}${o.deliveryAsWritten ? ` (${o.deliveryAsWritten})` : ''}` : null, o.tier ? o.tier : null, o.section ? `section ${o.section}` : null, o.row ? `row ${o.row}` : null].filter(Boolean).join(', ');
  const rows: OfferVerdict[] = offers.map((o) => {
    const tot = unknownCapacity(o) ? null : offerTotal(o, q);
    const why: OfferVerdict['why'] = [];
    if (unknownCapacity(o)) why.push({ kind: 'short', text: `it doesn’t say how many admissions the bundle includes, so I can’t count it as covering ${q === 1 ? 'you' : `${countWord(q)}${owned ? ' new tickets' : ''}`}` });
    if (o.availability === 'unavailable') why.push({ kind: 'availability', text: 'it is marked sold out or unavailable, so it is not an actionable option' });
    if (terms.requiredDay && (o.validDays && !o.validDays.includes(terms.requiredDay) || o.invalidDays?.includes(terms.requiredDay))) why.push({ kind: 'day', text: `${o.validDays ? `it is ${o.validDays.join('/')} only, ` : ''}not valid for your ${terms.requiredDay} admission` });
    if (o.collectionRestriction) why.push({ kind: 'transfer', text: o.collectionRestriction });
    if (o.transferRestriction) why.push({ kind: 'transfer', text: o.transferRestriction });
    if (o.admission === 'excluded') why.push({ kind: 'admission', text: 'it includes no concert admission, so it cannot get you into the show and is excluded from the admission comparison' });
    else if (o.admission === 'unknown' && (terms.concertAdmission || offers.some((x) => x.productKind !== 'unknown' && x.productKind !== undefined))) why.push({ kind: 'admission', text: 'admission entitlement is unknown; confirm that this product includes entry before buying' });
    const performance = performanceFailure(o.performance, terms.musicExperience);
    if (performance) why.push({ kind: 'performance', text: performance });
    const entry = entryFailure(o.entry, terms.night ?? null);
    if (entry) why.push({ kind: 'entry', text: entry });
    if (a.accessibilityRequired && !o.accessible) why.push({ kind: 'access', text: 'it isn’t described as accessible seating, which you need' });
    if (!a.accessibilityRequired && o.accessible) why.push({ kind: 'access', text: `these are wheelchair or companion spaces, which ${q > 1 ? 'no one in your group needs' : 'you don’t need'}; they’re for people who need them, and the venue can ask you to move` });
    if (o.quantity !== null && o.quantity < q) {
      // A fixed basket short of the party is short whatever it costs: it would leave someone out (R1-M02).
      const noun = o.productKind === 'package' ? (o.quantity === 1 ? 'admission' : 'admissions') : o.quantity === 1 ? 'ticket' : 'tickets';
      const left = q - o.quantity;
      why.push({ kind: 'short', text: `it has only ${countWord(o.quantity)} ${noun}, and you need ${countWord(q)}${owned ? ` new ${q === 1 ? 'one' : 'ones'}` : ''}, so it would leave ${left === 1 ? 'one person' : `${countWord(left)} people`} out` });
    }
    if (o.quantity !== null && o.quantity > q) {
      const allowed = terms.extra === 'allowed' && (terms.maxBuy === null || o.quantity <= terms.maxBuy);
      if (!allowed && (o.mustBuyAll || terms.extra === 'refused')) why.push({ kind: o.mustBuyAll ? 'block' : 'extra', text: o.mustBuyAll ? `it’s ${countWord(o.quantity)} tickets the seller won’t split, and you ${terms.extra === 'refused' ? 'won’t buy an extra' : `want ${countWord(q)}`}` : `it’s ${countWord(o.quantity)} tickets, and you won’t buy an extra; ask the seller whether they’ll sell exactly ${countWord(q)}` });
    }
    if (terms.view !== 'any' && (need.noObstructed || terms.view === 'unobstructed') && o.obstructed === true) why.push({ kind: 'view', text: 'it has an obstructed view, which you ruled out' });
    if (terms.concertAdmission && terms.view === 'unobstructed' && o.obstructed === null) why.push({ kind: 'view', text: 'an unobstructed view is not established by this offer, and you require it' });
    // Pairs are enough when each adult sits with a child (TGQA-R6 18): scattered singles fail that, adjacent pairs don't.
    // How they said the party must sit decides, not a general "together" the reader inferred: adjacent pairs are
    // enough when each child only needs an adult beside them, and nothing is required once they lift it (TGQA-R8 S01).
    if (terms.seating === 'pairs') {
      if (o.together === false && !o.pairs) why.push({ kind: 'together', text: 'they’re separate seats, so each child can’t sit beside an adult' });
    } else if (terms.seating !== 'any' && (need.togetherRequired || terms.seating === 'together') && o.together === false) why.push({ kind: 'together', text: o.pairs ? 'they’re two pairs, not all together' : 'the seats aren’t together' });
    if (deadline !== null) {
      if (o.deliveryMinutes === null) why.push({ kind: 'no_time', text: `it doesn’t say the tickets arrive before ${dl(deadline)}, your deadline` });
      else if (o.deliveryMinutes > deadline) {
        const late = o.deliveryMinutes - deadline;
        const by = late % 60 ? `${late} minutes` : late === 60 ? 'an hour' : `${late / 60} hours`;
        // In the zone they gave the deadline in, with the offer's own wording beside it (TGQA-R8 S02).
        const promised = otherZone ? `${timeLabel(fromVenueMinutes(o.deliveryMinutes, terms.deadlineZone!, tz))} ${terms.deadlineZone} time` : at(o.deliveryMinutes);
        // "11am Los Angeles time is 2pm New York time, an hour after your 1pm New York deadline": both clocks shown.
        const venueZone = venueZoneName(tz);
        const inVenue = `${timeLabel(o.deliveryMinutes)} ${venueZone ?? ''} time`.replace(/\s+/g, ' ');
        const crossZone = !!terms.deadlineZone && !!venueZone && terms.deadlineZone !== venueZone;
        why.push({ kind: 'late', text: crossZone ? `delivery by ${inVenue} is ${promised}, ${by} after your ${dl(deadline)} deadline` : `delivery by ${promised} misses your ${dl(deadline)} deadline` });
      }
    }
    const feesUnknown = !!tot && !tot.allIn && o.feeBasis !== 'all_in';
    if (budget !== null && tot && tot.cents > budget) why.push({ kind: 'budget', text: `over your ${formatUsd(budget)} budget by ${formatUsd(tot.cents - budget)}${tot.allIn ? '' : o.orderFeeCents !== null || o.perTicketFeeCents !== null ? ' with the stated charges; any remaining fees are unconfirmed' : ' before its fees'}` });
    return { o, tot, why, feesUnknown };
  });
  const fits = rows.filter((r) => !r.why.length && r.tot && !r.feesUnknown);
  const open = rows.filter((r) => !r.why.length && (!r.tot || r.feesUnknown));
  const byTotal = (x: OfferVerdict, y: OfferVerdict) => x.tot!.cents - y.tot!.cents;
  const cheapest = [...fits].sort(byTotal)[0] ?? null;
  // What matters most to them decides between offers that both fit (Research 1, R1-04): "being in the lower tier
  // matters most" takes the lower-tier one and names what it costs; "keeping the spend down" keeps the cheaper.
  const priority = terms.priority ?? null;
  const wanted = priority?.kind === 'feature' ? fits.find((r) => r.o.tier && sameFeature(r.o.tier, priority.words)) ?? null : null;
  const best = wanted ?? cheapest;
  const lines = rows.map((r) => {
    const d = describe(r.o);
    const room = r.feesUnknown && budget !== null && r.tot && r.tot.cents <= budget ? ` It fits your ${formatUsd(budget)} only if its ${unknownFees(r.o)} come to ${formatUsd(budget - r.tot.cents)} or less.` : '';
    // The reason itself, not a status label in front of it: "Over your $600 budget by $50." (writing review).
    const reasons = r.why.map((w, i) => (i === 0 ? w.text.charAt(0).toUpperCase() + w.text.slice(1) : w.kind === 'budget' ? `it’s also ${w.text}` : w.text));
    const verdict = r.why.length ? ` ${reasons.join('; ')}.` : r === best ? '' : fits.includes(r) && best ? ` Also fits${r.tot!.cents > best.tot!.cents ? `, ${formatUsd(r.tot!.cents - best.tot!.cents)} more` : r.tot!.cents < best.tot!.cents ? `, ${formatUsd(best.tot!.cents - r.tot!.cents)} less` : ', at the same total'}.` : room;
    return `${Name(r.o)}${d ? ` (${d})` : ''}: ${price(r.o, r.tot)}.${verdict}`;
  });
  // A promised transfer time is the seller's word, not a transfer that has happened (TGQA-R8 S02).
  const provenance = deadline !== null ? 'Based on the terms you sent; I haven’t verified availability, and a promised transfer time isn’t a completed transfer.' : 'Based on the details you sent; I haven’t verified availability.';
  const vs = (x: OfferVerdict, y: OfferVerdict) => {
    const d = y.tot!.cents - x.tot!.cents;
    return d > 0 ? `${formatUsd(d)} less than ${y.o.name}` : d < 0 ? `${formatUsd(-d)} more than ${y.o.name}` : `the same as ${y.o.name}`;
  };
  let choice: string;
  if (best) {
    const named = need.baseline && need.baseline !== best.o.label ? rows.find((r) => r.o.label === need.baseline && r.tot && !r.why.some((w) => w.kind === 'admission' || w.kind === 'performance' || w.kind === 'entry')) ?? null : null;
    const runnerUp = [...fits].sort(byTotal)[1] ?? null;
    const against = named ?? runnerUp;
    // With an offer whose fees aren't known, the known one is the straightforward choice, not yet a winner.
    // One offer kept from an earlier comparison ("ignore Offer A, only B") is judged on its own, and says so (live R05-F1).
    const alone = offers.length === 1;
    const setAside = a.offersSetAside?.length ? a.offersSetAside.join(' or ') : 'the other offer';
    const head = alone
      ? `Looking at ${best.o.name} on its own, with nothing from ${setAside} applied: it meets what you asked for, at ${formatUsd(best.tot!.cents)} for ${ticketsWord(best.tot!.tickets)}, fees included.`
      : `${Name(best.o)} ${open.length ? 'is the straightforward choice if you’d rather skip another checkout' : fits.length > 1 ? 'wins this one' : 'is the one that meets what you asked for'}: ${formatUsd(best.tot!.cents)} for ${ticketsWord(best.tot!.tickets)}, fees included.`;
    const bits: string[] = [];
    if (terms.concertAdmission && fits.length === 1) for (const r of rows.filter((r) => r !== best)) {
      // Admission only when it's excluded: an unknown one is "confirm first", not a reason to skip.
      const unusable = r.why.find((w) => ['availability', 'day', 'transfer', 'view', 'short'].includes(w.kind) || (w.kind === 'admission' && r.o.admission === 'excluded'));
      // A cheaper add-on is said for what it is, not as a bargain beside the tickets (R1-M01).
      const addOn = unusable?.kind === 'admission' && r.o.admission === 'excluded' && ['upgrade', 'parking', 'shuttle'].includes(r.o.productKind);
      if (addOn) bits.push(`Skip ${short(r.o)}: it’s ${r.o.productKind === 'upgrade' ? 'an upgrade' : `a ${r.o.productKind} pass`} with no concert admission, so its ${r.tot ? formatUsd(r.tot.cents) : 'price'} doesn’t get ${q === 1 ? 'you' : q === 2 ? 'either of you' : 'anyone'} into the show.`);
      // A basket too small is said once in brief here; its line below gives the reason in full (post-deploy R1 writing).
      else if (unusable?.kind === 'short' && r.o.quantity !== null) bits.push(`${short(r.o)} only covers ${countWord(r.o.quantity)} of the ${countWord(q)}${owned ? ' new tickets' : ''} you need.`);
      else if (unusable) bits.push(`Skip ${short(r.o)}: ${unusable.text}.`);
    }
    // Three or more that fit: the saving against each, not just the runner-up (TGQA-R6 14: "saves $10 or $5").
    const others = named ? [] : [...fits].sort(byTotal).filter((r) => r !== best);
    if (others.length >= 2) bits.push(`That’s ${others.slice(0, 3).map((o) => vs(best, o)).join(' and ')}.`);
    else if (against) bits.push(`That’s ${vs(best, against)}.`);
    // With a break-even to state, the threshold goes right beside the pick; budget left over would crowd it.
    if (budget !== null && best.tot!.cents <= budget && !open.length) bits.push(best.tot!.cents === budget ? `It’s exactly your ${formatUsd(budget)} budget.` : `It leaves ${formatUsd(budget - best.tot!.cents)} of your ${formatUsd(budget)} budget.`);
    // An offer whose fees aren't known yet: the fee that would make it cheaper, not a guess at its fees.
    for (const c of rows.filter((r) => r !== best && r.tot && r.feesUnknown && r.why.every((w) => w.kind === 'budget'))) {
      const gap = best.tot!.cents - c.tot!.cents;
      bits.push(gap > 0
        ? `${Name(c.o)} only beats it if its ${unknownFees(c.o)} come to less than ${formatUsd(gap)} in total: at ${formatUsd(gap)} they tie, and above that ${short(best.o)} costs less.`
        : gap === 0
          ? `${Name(c.o)} already costs the same ${statedCharges(c.o) ? 'with the charges you supplied' : 'before its fees'}: they tie if there are no ${unknownFees(c.o)}, and ${short(best.o)} costs less if any are added.`
          : statedCharges(c.o)
            ? `${Name(c.o)} is already ${formatUsd(-gap)} more with the charges you supplied; any remaining fees would widen that gap.`
            : `${Name(c.o)} already costs ${formatUsd(-gap)} more before its fees, so ${short(best.o)} costs less whatever they are.`);
    }
    if (owned) bits.unshift(owned === 1 ? 'Your own ticket is already covered.' : `The ${countWord(owned)} tickets you already have are covered.`);
    // No generic "check delivery" task: a deadline they gave is already checked against each offer, and without one it's
    // research the comparison doesn't need (post-deploy R1, useful reply standard).
    const check = '';
    // Their priority, said back as the reason: the pick is for them, not the cheapest by default.
    const dearer = priority?.kind === 'price' && best === cheapest ? [...fits].sort(byTotal).filter((r) => r !== best && r.tot!.cents > best.tot!.cents && r.o.tier)[0] : undefined;
    const personal = wanted && wanted !== cheapest && cheapest
      ? { head: `I’d take ${short(best.o)} for you: ${formatUsd(best.tot!.cents)} for ${ticketsWord(best.tot!.tickets)}, fees included.`, why: `It costs ${formatUsd(best.tot!.cents - cheapest.tot!.cents)} more than ${cheapest.o.name}, and since ${priority?.kind === 'feature' ? `the ${priority.words}` : 'that'} is what matters most to you, that’s the difference worth paying.${budget !== null && best.tot!.cents <= budget ? ` It leaves ${formatUsd(budget - best.tot!.cents)} of your ${formatUsd(budget)} budget.` : ''}` }
      : dearer
        ? { head: `I’d take ${short(best.o)} for you: ${formatUsd(best.tot!.cents)} for ${ticketsWord(best.tot!.tickets)}, fees included.`, why: `${budget !== null ? `It leaves ${formatUsd(budget - best.tot!.cents)} under your ${formatUsd(budget)} cap. ` : ''}${dearer.o.name} costs ${formatUsd(dearer.tot!.cents - best.tot!.cents)} more for the ${dearer.o.tier!.replace(/-/g, ' ')}; since keeping the spend down matters most to you, I wouldn’t pay that difference on the facts you’ve supplied.` }
        : null;
    // What they changed since the last turn is the reason the pick is what it is now, said first: not the old
    // reason restated, not a generic "wins this one" (post-deploy R1 writing review).
    const left = budget !== null && best.tot!.cents <= budget ? ` It leaves ${formatUsd(budget - best.tot!.cents)} of your ${formatUsd(budget)} budget.` : '';
    const premium = wanted === best && cheapest && cheapest !== best ? best.tot!.cents - cheapest.tot!.cents : null;
    const countDelta = before?.quantity != null && before.quantity !== q ? q - before.quantity : 0;
    // A ticket they no longer hold is named as the change: it's why the count went up (R1-M02-OWNERSHIP-REVERSAL-01).
    const lostOwn = !!before?.owned && !owned;
    const changedHead = countDelta
      ? `${lostOwn ? `Now that you don’t have your own ticket, that’s ${countWord(q)} to buy, so I’d take` : `With ${countWord(q)} ${owned ? 'new ' : ''}${q === 1 ? 'ticket' : 'tickets'} to buy now, I’d take`} ${short(best.o)}: ${formatUsd(best.tot!.cents)} in total, fees included.`
      : null;
    const words = priority?.kind === 'feature' ? priority.words : null;
    const changedPick = countDelta || premium === null || !words || !before
      ? null
      : before.priority?.kind === 'price'
        ? `Since you’d now pay more for the ${words}, I’d choose ${short(best.o)}: ${formatUsd(best.tot!.cents)} for ${ticketsWord(best.tot!.tickets)}, fees included. That’s ${formatUsd(premium)} more than ${cheapest!.o.name}.${left}`
        : before.budgetTotalCents !== null && budget !== null && before.budgetTotalCents < best.tot!.cents && before.budgetTotalCents !== budget
          ? `With your budget now ${formatUsd(budget)}, the ${words} fits, so I’d choose ${short(best.o)}: ${formatUsd(best.tot!.cents)} for ${ticketsWord(best.tot!.tickets)}, fees included. That’s ${formatUsd(premium)} more than ${cheapest!.o.name}, the other usable option, and the ${words} is what you said you’d prefer.${left}`
          : null;
    // A seat's place in the venue is their word, not a view anyone has checked.
    const basis = offers.some((o) => o.tier) && deadline === null ? 'That’s based on your quotes; I haven’t verified availability or the view.' : provenance;
    choice = changedPick
      ? `${changedPick} ${basis}`.replace(/\s+/g, ' ').trim()
      : personal && !changedHead
      ? `${personal.head} ${personal.why} ${basis}${check}`.replace(/\s+/g, ' ').trim()
      : `${changedHead ?? head} ${bits.join(' ')} ${provenance}${check}`.replace(/\s+/g, ' ').trim();
  } else if (open.length >= 2 && open.every((r) => r.tot)) {
    choice = `${open.map((r) => Name(r.o)).join(' and ')} meet what you asked for so far, but their fees aren’t known yet, so I can’t say which costs less until you see the checkout totals. ${provenance}`;
  } else if (open.length === 1) {
    const c = open[0]!;
    choice = `${Name(c.o)} is the only one left, but its ${unknownFees(c.o)} aren’t known yet${c.tot && budget !== null ? `: it fits your ${formatUsd(budget)} only if they come to ${formatUsd(budget - c.tot.cents)} or less` : ''}. ${provenance}`;
  } else {
    // Nothing fits: the smallest single change that would make one work, said as a choice for them to make.
    const oneOff = rows.filter((r) => r.why.length === 1 && r.tot && !r.feesUnknown);
    const byBudget = oneOff.filter((r) => r.why[0]!.kind === 'budget').sort(byTotal)[0] ?? null;
    const byExtra = oneOff.find((r) => r.why[0]!.kind === 'block' || r.why[0]!.kind === 'extra') ?? null;
    const change = byBudget
      ? `The smallest change: if you can stretch to ${formatUsd(byBudget.tot!.cents)} in total, ${byBudget.o.name} meets everything else.`
      : byExtra
        ? `The smallest change: if you’d buy ${countWord(byExtra.tot!.tickets)} tickets, ${byExtra.o.name} meets everything else, at ${formatUsd(byExtra.tot!.cents)}.`
        : '';
    choice = offers.length === 1
      ? `Looking at ${rows[0]!.o.name} on its own, with nothing from ${a.offersSetAside?.length ? a.offersSetAside.join(' or ') : 'the other offer'} applied: it doesn’t meet what you asked for. ${change} ${provenance}`.replace(/\s+/g, ' ').trim()
      : a.accessibilityRequired && rows.every((r) => !r.o.accessible)
      ? 'Neither is described as accessible seating, which you need, so I’d check with the seller or venue before buying either.'
      : `None of ${offers.length === 2 ? 'the two' : 'these'} meets all your requirements. ${change} ${provenance}`.replace(/\s+/g, ' ').trim();
  }
  return {
    id: 'C_OFFERS',
    kind: 'catches',
    text: `${choice}\n${lines.join('\n')}`,
    items: lines,
    values: { offers: offers.length, fits: fits.length, open: open.length },
    scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: a.observedAt.toISOString() },
    evidenceIds: [],
    methodVersion: 'text-offers-3.0',
    limitations: ['customer_supplied_evidence', 'not_verified_offers'],
    customerVisible: true,
  };
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
  // A before-fees listing is not "cheaper" than an all-in price just by being lower: its fees are still to come.
  // One within a normal fee margin is noise to hunt for, not an alternative (live R05-F1: $207.62 before fees
  // headlined against $210 all-in). The rest carry the fee that would make them cheaper.
  if (a.marketAround && a.subject && a.subject.feeBasis === 'all_in' && a.subject.perTicketCents !== null) {
    const sub = a.subject.perTicketCents;
    a = { ...a, marketAround: { ...a.marketAround, alternatives: a.marketAround.alternatives.filter((x) => sub - x.listing.priceCents >= Math.max(1000, Math.round(sub * 0.2))) } };
  }
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
    const marketShown = !!(a.market?.visible && (a.market.context?.current || a.marketAround));
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
        : a.best || marketShown
          ? '' // the verified option or the resale figures below are the comparison
          : a.subject
            ? '' // the listing's own verdict already says the market can't be compared yet: said once (TGQA-R8 S10)
            : `I can’t see what sellers are charging for this ${a.eventNoun ?? 'event'} yet, so I can’t say whether that’s low or high.`;
    claims.push({
      id: 'C_QUOTE',
      kind: 'quoted_price',
      text: [quoteLead(a.quote), verdictText].filter(Boolean).join(' '),
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
  if (a.subject) {
    claims.push(verdictClaim(a, a.subject));
    claims.push(subjectClaim(a, a.subject));
    const catches = catchesClaim(a, a.subject);
    if (catches) claims.push(catches);
    if (a.marketAround) claims.push(alternativesClaim(a, a.marketAround));
    const verified = verifiedClaim(a, a.subject);
    if (verified) claims.push(verified);
  }
  if (a.official) {
    claims.push({
      id: 'C_OFFICIAL',
      kind: 'official_sale',
      // "Unless resale is cheaper" only when there is resale in the email to be cheaper; otherwise it reads as a hedge we can't back.
      // The sale being open says nothing about seats: with a budget, access needs or a seat preference, it's a
      // place to look, not a recommendation (TG-B01).
      text: a.priorities.budgetTotalCents != null || a.accessibilityRequired || a.seatingPreference
        ? `It’s also on general sale on ${a.official.seller}. I haven’t seen those seats or their prices, so check ${listJoin(['the all-in total', ...(a.accessibilityRequired ? ['the access you need'] : []), ...(a.seatingPreference ? ['the seats'] : [])])} there before you buy.`
        : a.best || (a.market?.visible && a.market.context?.current) ? `It’s still on general sale on ${a.official.seller}, which is where I’d buy unless a resale seat is clearly cheaper.` : `It’s on general sale on ${a.official.seller}, and that’s where I’d buy.`,
      values: { seller: a.official.seller },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['sale_window_not_inventory'],
      customerVisible: true,
      url: a.official.url,
      linkLabel: a.priorities.budgetTotalCents != null || a.accessibilityRequired || a.seatingPreference ? `Event page on ${a.official.seller}` : `Buy on ${a.official.seller}`,
    });
  }

  if (a.best && a.best.comparableTotalCents !== null) {
    const total = a.best.comparableTotalCents;
    const pp = perPersonCents(total, q);
    claims.push({
      id: 'C_BEST',
      kind: 'current_offer',
      text: `${q} seat${q > 1 ? 's' : ''} together${a.best.offer.section ? ` in section ${a.best.offer.section}` : ''}: ${formatUsd(total)} total (${formatUsd(pp)} each) including the verified charges, checked ${checkedAt(new Date(a.best.offer.observedAt), a.timeZone)}.`,
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
      // The window ends at the latest observation, not at the time of this reply (R2-TREND-TIME-01).
      const latest = a.trend.latestObservedAt ?? a.observedAt;
      const lagMinutes = (a.observedAt.getTime() - latest.getTime()) / 60_000;
      const span = lagMinutes <= 90 ? `over the last ${w.windowHours} hours` : `in the ${w.windowHours} hours up to ${checkedAt(latest, a.timeZone)}`;
      claims.push({
        id: 'C_TREND',
        kind: 'trend_change',
        text: `Your group's cheapest comparable option has ${dirWord} from ${formatUsd(w.baselineCents)} to ${formatUsd(w.currentCents)} ${span} (${a.trend.direction === 'flat' || a.trend.direction === 'mixed' ? 'no clear direction' : a.trend.direction}).${newSource} Past movement does not predict the next one.`,
        values: { baselineCents: w.baselineCents, currentCents: w.currentCents, windowHours: w.windowHours, direction: a.trend.direction },
        scope: { quantity: q, seatZone: null, feeBasis: 'verified_total', observedAt: latest.toISOString() },
        evidenceIds: a.trend.validObservationIds,
        methodVersion: a.trend.methodVersion,
        limitations: a.trend.qualityFlags,
        customerVisible: a.trendDisplayAllowed !== false,
      });
    } else {
      // A series that ended long ago is history: said with its real dates, never as recent (R2-TREND-TIME-01).
      const h = a.trend.historical;
      const latest = a.trend.latestObservedAt;
      const text = h
        ? `The newest comparable price I have for your group is from ${checkedAt(h.toAt, a.timeZone)}, too old to say how prices are moving now. Between ${checkedAt(h.fromAt, a.timeZone)} and then, it went from ${formatUsd(h.fromCents)} to ${formatUsd(h.toCents)}.`
        : latest && a.trend.freshness === 'historical'
          ? `The newest comparable price I have for your group is from ${checkedAt(latest, a.timeZone)}, too old to say how prices are moving now.`
          : `We have only ${a.trend.validObservationIds.length} comparable price observation${a.trend.validObservationIds.length === 1 ? '' : 's'} over ${Math.round(a.trend.spanMinutes / 60)} hours for your group size, which isn't enough to call a trend.`;
      claims.push({
        id: 'C_NOTREND',
        kind: 'trend_change',
        text,
        values: { observations: a.trend.validObservationIds.length, spanMinutes: a.trend.spanMinutes },
        scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: latest?.toISOString() ?? obs },
        evidenceIds: a.trend.validObservationIds,
        methodVersion: a.trend.methodVersion,
        limitations: a.trend.reasons,
        customerVisible: h ? a.trendDisplayAllowed !== false : true,
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
  // A link to one listing we can't open: said first, so the market figures after it aren't read as that
  // listing's (post-#54 QA, L01).
  if (a.link && !a.subject && !a.quote && !a.best) {
    claims.push({
      id: 'C_LINK_UNREAD',
      kind: 'coverage',
      text: `I can’t open ${a.link.marketplace} listings myself, so I haven’t seen the one you sent: not its section and row, its total with fees, or its catches. What follows is the resale market for ${a.quantity === 1 ? 'one ticket' : `${countWord(a.quantity)} tickets`}, not that listing.`,
      values: { marketplace: a.link.marketplace },
      scope: { quantity: a.quantity, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['link_read_from_url_only'],
      customerVisible: true,
    });
  }
  // Their own question, when it isn't "is this a good price": delivery against their travel, and wheelchair
  // spaces weighed against ordinary seats. Neither answer promises delivery, entry or suitability.
  if (a.asks?.deliveryRisk) {
    const by = a.subject?.deliveryBy ? ` The listing says delivery by ${shortDate(a.subject.deliveryBy)}.` : '';
    claims.push({
      id: 'C_DELIVERY',
      kind: 'catches',
      text: `On delivery:${by} If the tickets might only arrive after you’ve set off, you could be travelling with nothing in hand, and a refund guarantee, if the seller offers one, gives the money back; it doesn’t get you into the ${a.eventNoun ?? 'game'}. So pick a listing that says it delivers before you leave, and keep the seller’s support details with you.`,
      values: { deliveryBy: a.subject?.deliveryBy ?? null },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['no_authenticity_or_delivery_guarantee'],
      customerVisible: true,
    });
  }
  // With a listing of theirs, the verdict and its catches check it against these; this is for requests without.
  if (a.requirements?.length && !a.subject && !(a.textOffers && a.textOffers.length >= 2) && !(a.best && a.best.comparableTotalCents !== null)) {
    const reqs = a.requirements;
    claims.push({
      id: 'C_REQS',
      kind: 'coverage',
      text: `I haven’t been able to check ${reqs.length === 1 ? 'this' : 'these'} against any seats yet: ${joinRequirements(reqs.map((r) => r.replace(/^./, (c) => c.toLowerCase())))}. Nothing I can check automatically has shown me seats that meet ${reqs.length === 1 ? 'it' : 'all of them'}, so I can’t recommend any yet.`,
      values: { requirements: reqs.length },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['requirements_unverified'],
      customerVisible: true,
    });
  }
  if (a.staffFollowUp) {
    // Owned, and said with its limits: what the person will do, where the answer comes, and no promised result.
    claims.push({
      id: 'C_STAFF',
      kind: 'coverage',
      text: `So you don’t have to do the shopping: a person on our team is now looking for seats that meet ${a.requirements?.length ? (a.requirements.length === 1 ? 'it' : 'all of them') : 'what you asked for'}, checking sellers by hand. They’ll reply in this thread with the options they find and their all-in totals, or tell you plainly if nothing fits. The team replies from ${a.staffFollowUp.hours}.`,
      values: {},
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['staff_assisted'],
      customerVisible: true,
    });
  }
  if (a.textOffers && a.textOffers.length >= (a.offersSetAside?.length ? 1 : 2)) claims.push(offersClaim(a, a.textOffers));
  // A parking pass is not a way in: say so first, and what they need instead, from their own price (V03).
  if (a.asks?.parking) {
    const p = a.asks.parking;
    const whole = p.admissionEachCents !== null ? p.admissionEachCents * q : null;
    claims.push({
      id: 'C_PARKING',
      kind: 'catches',
      text: `No: a “parking only” listing is a parking pass, not a ticket to the ${a.eventNoun ?? 'game'}, so it won’t get ${q === 1 ? 'you' : q === 2 ? 'either of you' : 'any of you'} in. What you need is event admission, one ticket each${whole !== null ? `: at the ${formatUsd(p.admissionEachCents!)} each you found${p.admissionAllIn ? ', fees included' : ''}, that’s ${formatUsd(whole)} for ${q === 1 ? 'one' : q === 2 ? 'both' : `all ${countWord(q)}`}${p.admissionAllIn ? '' : ', plus fees'}` : ''}. If you do buy parking too, it only adds to that.`,
      values: { admissionEachCents: p.admissionEachCents, totalCents: whole },
      scope: { quantity: q, seatZone: null, feeBasis: p.admissionAllIn ? 'all_in' : null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['customer_supplied_evidence'],
      customerVisible: true,
    });
  }
  // "How many have actually sold?": we see asking prices, never sales, and say so (audit A10).
  if (a.asks?.salesAsked) {
    claims.push({
      id: 'C_SALES',
      kind: 'coverage',
      text: 'On sales: I can’t tell you how many tickets have sold. What I can see are asking prices on StubHub and Vivid Seats listings, not completed sales, and a listing that disappears may have been sold, moved or withdrawn.',
      values: {},
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['asking_prices_not_sales'],
      customerVisible: true,
    });
  }
  if (a.asks?.accessibleSpaces && !(a.textOffers && a.textOffers.length >= 2)) {
    claims.push({
      id: 'C_ACCESS',
      kind: 'catches',
      text: a.accessibilityRequired
        ? 'On the accessible spaces: I can’t tell from a listing whether a space suits your needs (the route to it, a companion seat next to it), so check that with the seller or the venue before you buy.'
        : 'On the wheelchair spaces: they’re for people who use a wheelchair and their companions, not a cheaper version of ordinary seats, so I wouldn’t weigh them against the others on price. If no one in your group needs one, the ordinary seats are the ones to compare, and the venue can ask you to move from a wheelchair space. If someone does need one, tell me and I’ll look at those spaces properly.',
      values: { accessibilityRequired: a.accessibilityRequired ? 1 : 0 },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['venue_policy_varies'],
      customerVisible: true,
    });
  }
  if (a.leftOut?.length) {
    const say = (l: NonNullable<BuildPacketArgs['leftOut']>[number]) =>
      l.reason === 'obstructed_view' ? 'one has an obstructed view, which you ruled out'
        : l.reason === 'bigger_block' ? `one is a block of ${l.quantity} that may not sell as exactly ${q}, with its charges unknown`
          : l.reason === 'accessible_only' ? 'one is wheelchair or companion spaces, meant for people who need them'
            : l.reason === 'seats_not_together' ? 'one isn’t seats together'
              : 'one is outside the sections you’d take';
    const n = a.leftOut.length;
    claims.push({
      id: 'C_LEFT_OUT',
      kind: 'coverage',
      text: `I left out ${n === 1 ? 'a cheaper listing' : `${countWord(n)} cheaper listings`}: ${((xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join('; ')}; and ${xs[xs.length - 1]}`))(a.leftOut.slice(0, 4).map(say))}.`,
      values: { count: n },
      scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: ['not_offered_as_alternative'],
      customerVisible: true,
    });
  }
  if (a.watchStatus) {
    const w = a.watchStatus;
    claims.push({
      id: 'C_WATCH',
      kind: 'coverage',
      text: w.running
        ? `I’m watching this for you: ${w.quantity} tickets${w.togetherRequired ? ' together' : ''}, and I’ll email you if I find them for ${formatUsd(w.targetTotalCents)} or less in total, including fees. The watch ends ${checkedAt(w.expiresAt, a.timeZone)}. Reply “stop” any time to end it.`
        : 'I can’t watch prices for you yet, so nothing is being monitored for this request and no alert will come. Reply any time and I’ll check again.',
      values: w.running ? { running: 1, quantity: w.quantity, targetTotalCents: w.targetTotalCents, expiresAt: w.expiresAt.toISOString() } : { running: 0 },
      scope: { quantity: w.running ? w.quantity : q, seatZone: null, feeBasis: w.running ? 'verified_total' : null, observedAt: obs },
      evidenceIds: [],
      methodVersion: null,
      limitations: w.running ? [] : ['no_monitoring'],
      customerVisible: true,
    });
  }
  // Their own offers are the whole question: a venue-wide floor doesn't change which of them to buy, and
  // reading it cost the answer its first line (post-#55 writing review, X01).
  const comparing = !!(a.textOffers && a.textOffers.length >= (a.offersSetAside?.length ? 1 : 2));
  const market = comparing ? [] : marketClaims(a, obs);
  claims.push(...market);
  // Their own offers are the question; what the market floor leaves of their budget isn't (post-#54 QA).
  const read = market.some((c) => c.id === 'C_MARKET' && c.kind === 'market_price') && !(a.textOffers && a.textOffers.length >= 2) ? marketRead(a) : null;
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
        : `I can’t see live resale listings for this ${a.eventNoun ?? 'event'} yet, so this doesn’t compare other sellers’ prices.`
      : `Checked: ${a.sourcesChecked.join(', ')}.${failed.length ? ` Couldn’t reach: ${failed.join(', ')}.` : ''} Prices can change before checkout.`,
    values: { checked: a.sourcesChecked.length, unavailable: unavailable.length },
    scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs },
    evidenceIds: [],
    methodVersion: null,
    limitations: [],
    // With a listing we read and no market to set it against, its verdict already says so; once is enough.
    customerVisible: !comparing && !(noMarket && !marketShown && (a.subject || a.quote)),
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

  // "Better to buy now or wait? Do you have price history for comparable seats?": a direct answer from the evidence
  // we hold for their group, or a plain abstention; never a trend we can't support, never an alert (TGQA-R6 1011).
  if (a.trendAsked) {
    const trendClaim = claims.find((c) => c.id === 'C_TREND' && c.customerVisible);
    const thin = claims.find((c) => c.id === 'C_NOTREND');
    const seats = `${q === 1 ? 'one seat' : `${countWord(q)} seats together`}`;
    const risk = a.trendAsked.riskOk ? ' You’re willing to risk missing out, but that alone doesn’t show that waiting will save money.' : '';
    const text = trendClaim
      ? `On buy or wait: ${trendClaim.text}${risk}`
      : `I don’t have a supported price trend for ${seats} at this ${a.eventNoun ?? 'event'}, so I can’t tell you whether prices are rising or falling, and waiting would be a guess.${thin ? ` ${thin.text}` : ' I haven’t collected a comparable price history for it yet.'}${risk}`;
    for (const c of claims) if (['C_TREND', 'C_NOTREND', 'C_NOHIST'].includes(c.id)) c.customerVisible = false;
    claims.push({ id: 'C_TREND_ANSWER', kind: 'trend_change', text: `${text}${a.trendAsked.noAlerts ? ' I haven’t set an alert.' : ''}`, values: { supported: trendClaim ? 1 : 0 }, scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs }, evidenceIds: [], methodVersion: null, limitations: trendClaim ? [] : ['insufficient_history'], customerVisible: true });
  }

  // Their correction, acknowledged first and specifically, then the answer on the corrected facts (live A11-F1).
  if (a.corrections?.length) {
    const xs = a.corrections;
    claims.unshift({ id: 'C_CORRECTION', kind: 'catches', text: `Updated from your email: ${xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join('; ')}; and ${xs[xs.length - 1]}`}.`, values: { changes: xs.length }, scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs }, evidenceIds: [], methodVersion: null, limitations: ['customer_supplied_evidence'], customerVisible: true });
  }
  // The price comparison is said once: as the verdict when it is the verdict, not again as "Against resale".
  const verdictCode = claims.find((c) => c.id === 'C_VERDICT')?.values.code;
  if (typeof verdictCode === 'string' && verdictCode.startsWith('price_')) for (const c of claims) if (c.id === 'C_QUOTE_MARKET') c.customerVisible = false;
  // The $20 parking price is not a ticket price to judge against the market, and a question about what gets them in
  // is answered by that alone: no seat search, history or coverage note under it (live V03).
  if (a.asks?.parking) for (const c of claims) if (!['C_PARKING', 'C_CORRECTION'].includes(c.id)) c.customerVisible = false;
  // A made-up example (their word): what it shows, and nothing about live listings, checking out or buying (A11).
  // The writing review's shape: the total and the per-ticket price with fees in one line, then the working, the
  // seats and the catches as short points, each said once (live A11-F1 said $264 three times and 6pm twice).
  if (a.synthetic) {
    for (const c of claims) if (['C_VERDICT', 'C_QUOTE_MARKET', 'C_ALTERNATIVES', 'C_VERIFIED', 'C_MARKET', 'C_MARKET_TYPICAL', 'C_READ', 'C_COVERAGE', 'C_FACE', 'C_BENCH', 'C_NOHIST', 'C_TREND', 'C_NOTREND', 'C_COUNT', 'C_ENTRY', 'C_CHECKPOINT', 'C_REQS', 'C_STAFF', 'C_CATCHES', 'C_CORRECTION'].includes(c.id)) c.customerVisible = false;
    const sub = a.subject ?? null;
    const qt = a.quote;
    const quoteClaim = claims.find((c) => c.id === 'C_QUOTE');
    const subjectClaim = claims.find((c) => c.id === 'C_SUBJECT');
    if (sub && qt && quoteClaim) {
      const n = qt.base?.tickets ?? sub.quantity ?? a.quantity;
      const allIn = qt.feeBasis === 'all_in';
      const total = qt.base?.totalCents ?? sub.wholePartyCents ?? (allIn ? qt.perTicketCents * n : null);
      const tickets = `${countWord(n)} ticket${n === 1 ? '' : 's'}`;
      const price = allIn && total !== null
        ? `${formatUsd(total)} in total, ${formatUsd(qt.perTicketCents)} each including fees`
        : `${formatUsd(qt.perTicketCents)} each${qt.feeBasis === 'before_fees' ? ' before fees' : ', and it doesn’t say whether that includes fees'}`;
      quoteClaim.text = a.corrections?.length ? `Updated from your email: ${tickets}, ${price}.` : `${a.correctionMatches ? 'Your numbers match what I read. ' : ''}The example ${sub.source === 'screenshot' ? 'image' : 'listing'} shows ${tickets}: ${price}.`;
      const seats = sub.seatNumbers?.length ? seatList(sub.seatNumbers) : null;
      const where = [sub.section ? `section ${sub.section}` : null, sub.row ? `row ${sub.row}` : null, seats].filter(Boolean).join(', ');
      const time = sub.deliveryText ? DELIVERY_TIME.exec(sub.deliveryText)?.[1]?.replace(/\s+/g, '').toLowerCase() ?? null : null;
      const delivery = time ? `delivery by ${time}${sub.deliveryBy ? ` on ${shortDate(sub.deliveryBy)}` : ''}` : sub.deliveryBy ? `delivery by ${shortDate(sub.deliveryBy)}` : null;
      const limits = [...new Set(sub.restrictions.map((r) => (/obstruct|limited view|partial view/i.test(r) ? 'Limited or obstructed view' : r.replace(/\.$/, ''))))];
      const items = [
        qt.base ? `${formatUsd(qt.base.perTicketCents)} × ${n}, plus ${formatUsd(qt.base.feesCents)} in fees for the whole order.` : null,
        where ? `${where.charAt(0).toUpperCase()}${where.slice(1)}${sub.seatsTogether ? ', together' : ''}.` : null,
        [...limits, delivery].filter(Boolean).length ? `${[...limits, delivery].filter(Boolean).join('; ').replace(/^./, (x) => x.toUpperCase())}.` : null,
      ].filter((x): x is string => !!x);
      if (subjectClaim) {
        subjectClaim.text = items.join('\n');
        subjectClaim.items = items;
      }
    }
    // Only a new version replaces what the image showed; a correction of how it was read doesn't (A11-F1 vs A11-F2).
    const replaced = (a.corrections ?? []).some((x) => /^(?:\w+ tickets|\$[\d,.]+ a ticket (?:before|including) fees|\$[\d,.]+ in total|delivery by)\b/.test(x));
    claims.push({ id: 'C_SYNTHETIC', kind: 'coverage', text: `${replaced ? 'These replace what the image showed. ' : ''}Since it’s a fictional example, there’s no live offer to check.`, values: {}, scope: { quantity: q, seatZone: null, feeBasis: null, observedAt: obs }, evidenceIds: [], methodVersion: null, limitations: ['customer_supplied_evidence'], customerVisible: true });
  }
  // Their hypothetical ("another offer at $98.89 each BEFORE fees: does adding its fees make the gap larger or
  // smaller?"), answered from their two numbers, not from any market figure (live A11-F1).
  const gapAsk = a.asks?.gapAgainst ?? null;
  if (gapAsk && a.quote && a.quote.feeBasis === 'all_in') {
    const ours = a.quote.perTicketCents;
    const other = gapAsk.perTicketCents;
    const d = Math.abs(other - ours);
    const text = !gapAsk.beforeFees
      ? `Both prices include fees, so the gap stays ${formatUsd(d)} a ticket.`
      : other >= ours
        ? `Larger. At ${formatUsd(other)} before fees it already costs ${formatUsd(d)} a ticket more than the ${formatUsd(ours)} all-in, and its fees can only add to that.`
        : `Smaller, at first: at ${formatUsd(other)} before fees it starts ${formatUsd(d)} a ticket below the ${formatUsd(ours)} all-in, and its fees close that gap. If they come to more than ${formatUsd(d)} a ticket, it ends up costing more.`;
    claims.push({ id: 'C_GAP', kind: 'catches', text, values: { oursCents: ours, otherCents: other }, scope: { quantity: q, seatZone: null, feeBasis: 'all_in', observedAt: obs }, evidenceIds: [], methodVersion: null, limitations: ['customer_supplied_evidence'], customerVisible: true });
  }
  // Comparing their offers, the comparison is the email: history, group counts, a generic delivery warning or a
  // coverage note after it only repeat or contradict it (live M03: "On delivery…" under a pick that already
  // enforced the deadline).
  if (comparing) for (const c of claims) if (!['C_OFFERS', 'C_SALES', 'C_WATCH', 'C_LINK_UNREAD'].includes(c.id)) c.customerVisible = false;
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
    followUps: a.synthetic || a.asks?.parking || comparing ? [] : followUpQuestions(a),
    // The brief as we hold it, so a change ("six, up to $720") is visible in the reply (retest R02-F1).
    // A "budget" that is just the price they showed us ($210 each, four tickets) is not said back as one.
    headline: `${a.eventLabel} · ${a.quantity === 1 ? '1 ticket' : `${a.quantity} tickets`}${a.priorities.budgetTotalCents != null && a.priorities.budgetTotalCents !== (a.quote ? a.quote.perTicketCents * a.quantity : null) && a.priorities.budgetTotalCents !== (a.subject?.wholePartyCents ?? null) && !(a.textOffers ?? []).some((o) => (o.totalCents ?? (o.perTicketCents ?? -1) * a.quantity) === a.priorities.budgetTotalCents) ? ` · up to ${formatUsd(a.priorities.budgetTotalCents)} in total` : ''}${a.link ? ` · from the ${a.link.marketplace} link you sent` : ''}`,
    evidenceExpiresAt: a.evidenceExpiresAt?.toISOString() ?? null,
    eventStartAt: a.eventStartAt?.toISOString() ?? null,
    nextCheckpointAt: a.policy.nextCheckpointAt?.toISOString() ?? null,
    stopConditions: a.policy.stopConditions,
    watchConsentReference: a.watchConsentReference,
    isFixture: a.isFixture,
  };
}

/** "a and b", or "a; and b" when an item already has its own "and"; of two, one with a trailing clause goes last. */
/** "lower tier" against "lower tier seats", "the floor" against "floor seats": the same part of the venue. */
function sameFeature(tier: string, words: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/-/g, ' ').replace(/\b(?:the|seats?|a)\b/g, '').replace(/\blevel\b/, 'tier').replace(/\s+/g, ' ').trim();
  return norm(tier) === norm(words) || norm(tier).includes(norm(words)) || norm(words).includes(norm(tier));
}

export function joinRequirements(items: string[]): string {
  if (items.length === 1) return items[0]!;
  const xs = items.length > 2 ? items : [...items.filter((x) => !x.includes(',')), ...items.filter((x) => x.includes(','))];
  const semi = xs.length > 2 || xs.slice(0, -1).some((x) => /\band\b|,/.test(x));
  return semi ? `${xs.slice(0, -1).join('; ')}; and ${xs[xs.length - 1]}` : `${xs[0]} and ${xs[1]}`;
}
