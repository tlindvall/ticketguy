import { loadRegistry, type RegistrySource } from './registry';

/**
 * What it would actually take to get data out of each registry source. The registry records every
 * source as `not_integrated`, which is true and useless: it reads as a backlog of 135 adapters when most
 * entries can never be an adapter at all. This is the classification the sources page and the partner
 * plan are built on. It is configuration derived from the research, not a live check of anything.
 */
export type AccessClass =
  | 'catalog_api' // official event-level API; never a listing (Ticketmaster Discovery)
  | 'listing_api_partner' // documented listing/inventory API that exists only behind a commercial agreement
  | 'listing_no_api' // seller with real prices and no API of any kind: manual research, permanently unless they answer
  | 'primary_platform' // venue-side ticketing engine or seller of record; the venue/show page is the source, never an adapter
  | 'routing_reference' // official authority that says who the seller of record is; followed, not integrated
  | 'context_rule'; // discounts, lotteries, eligibility, cardholder presales, discovery: a policy fact per event, not inventory

export type AccessProfile = {
  class: AccessClass;
  label: string;
  /** What has to happen next for this source to contribute more than it does today. */
  nextAction: string;
  /** Where to apply, when a programme exists. */
  programmeUrl: string | null;
  /** Whether an automated adapter is even conceivable for this source. */
  automatable: boolean;
};

export const ACCESS_CLASS_META: Record<AccessClass, { label: string; nextAction: string; automatable: boolean }> = {
  catalog_api: { label: 'Catalog API', nextAction: 'Free developer key; enable the adapter row with the terms-acceptance evidence. Events only, never a price.', automatable: true },
  listing_api_partner: { label: 'Listing API — partner agreement', nextAction: 'File the partner application. When credentials arrive, run the probe; the adapter is written only against a payload that has been seen.', automatable: true },
  listing_no_api: { label: 'Listings, no API', nextAction: 'No API exists. Manual research through the console links; a partner arrangement only if they answer an email.', automatable: false },
  primary_platform: { label: 'Primary platform / seller of record', nextAction: 'Never an adapter: the venue or show page is the source. Linked from the console when the route calls for it.', automatable: false },
  routing_reference: { label: 'Official routing reference', nextAction: 'Says who the seller of record is. Followed by a person, not integrated.', automatable: false },
  context_rule: { label: 'Context rule', nextAction: 'A per-event policy fact (rush, lottery, presale, eligibility). Recorded in the advice, never fetched.', automatable: false },
};

/** Sources where the research established a documented programme. Everything else is classified by rule. */
const KNOWN: Record<string, { class: AccessClass; programmeUrl: string | null }> = {
  ticketmaster: { class: 'catalog_api', programmeUrl: 'https://developer.ticketmaster.com' },
  'ticketmaster-partner-api': { class: 'listing_api_partner', programmeUrl: 'https://developer.ticketmaster.com/products-and-docs/apis/partner/' },
  stubhub: { class: 'listing_api_partner', programmeUrl: 'https://developer.stubhub.com' },
  'stubhub-api': { class: 'listing_api_partner', programmeUrl: 'https://developer.stubhub.com' },
  'ticket-evolution': { class: 'listing_api_partner', programmeUrl: 'https://developer.ticketevolution.com' },
  seatgeek: { class: 'listing_api_partner', programmeUrl: 'https://platform.seatgeek.com' },
  ticketnetwork: { class: 'listing_api_partner', programmeUrl: 'https://www.ticketnetwork.com/en/affiliate-tools' },
};

const ROUTING_TYPES = ['Official routing', 'Official show directory', 'Promoter/official links', 'Venue directory'];
const CONTEXT_TYPES = ['Discount', 'Rush', 'Lottery', 'Eligibility', 'Cardholder', 'Employer', 'Group sales', 'Hospitality', 'Discovery', 'Seat context', 'Offers', 'Artist discovery'];

type Classifiable = Pick<RegistrySource, 'id' | 'source_type' | 'routing_tier'>;

export function accessClassFor(s: Classifiable): AccessClass {
  const known = KNOWN[s.id];
  if (known) return known.class;
  if (s.routing_tier === 'integration_candidate') return 'listing_api_partner';
  if (s.routing_tier === 'core' || s.routing_tier === 'extended') return 'listing_no_api';
  if (s.routing_tier === 'context_only') return 'context_rule';
  // Fan exchanges list real tickets at face value; none exposes an API, so they are checked like any other seller.
  if (s.source_type === 'Fan exchange') return 'listing_no_api';
  if (ROUTING_TYPES.some((t) => s.source_type.startsWith(t))) return 'routing_reference';
  if (CONTEXT_TYPES.some((t) => s.source_type.includes(t))) return 'context_rule';
  return 'primary_platform';
}

export function accessProfileFor(s: Classifiable): AccessProfile {
  const cls = accessClassFor(s);
  return { class: cls, ...ACCESS_CLASS_META[cls], programmeUrl: KNOWN[s.id]?.programmeUrl ?? null };
}

/** Counts per class across the registry, in the order a reader should see them. */
export function accessSummary(sources: readonly Classifiable[] = loadRegistry().sources): Array<{ class: AccessClass; label: string; count: number; automatable: boolean }> {
  const order: AccessClass[] = ['catalog_api', 'listing_api_partner', 'listing_no_api', 'primary_platform', 'routing_reference', 'context_rule'];
  return order.map((c) => ({ class: c, label: ACCESS_CLASS_META[c].label, automatable: ACCESS_CLASS_META[c].automatable, count: sources.filter((s) => accessClassFor(s) === c).length }));
}
