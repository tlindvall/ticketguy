import type { Offer, SearchInput, SourceResult, SourceStatus } from '@/lib/domain/types';
import { OfferSchema } from '@/lib/domain/types';

/**
 * Adapter contract (API_AND_DATA_CONTRACTS §2). Capabilities are explicit; unsupported methods return a
 * typed status, never fake empty inventory. Disabled/credential-less adapters report not_configured /
 * access_not_approved and never return synthetic offers.
 */
export type Capability = 'discovery' | 'event_lookup' | 'quote_search' | 'quote_revalidation' | 'monitoring';

export interface TicketSourceAdapter {
  readonly sourceId: string;
  readonly implementation: string;
  readonly capabilities: readonly Capability[];
  resolveEvent(eventId: string): Promise<{ providerEventId: string | null; status: SourceStatus }>;
  search(input: SearchInput): Promise<SourceResult>;
  revalidate(offerId: string, input: SearchInput): Promise<SourceResult>;
}

export type AdapterActivation = {
  sourceId: string;
  implementation: 'not_integrated' | 'manual' | 'fixture' | 'ticketmaster_discovery';
  enabled: boolean;
  accessApprovalEvidence: string | null;
  monitoringAllowed: boolean;
};

function result(sourceId: string, status: SourceStatus, reasonCode: string | null, notes: string[], offers: Offer[] = []): SourceResult {
  return { sourceId, status, checkedAt: new Date().toISOString(), offers, reasonCode, retryAfterSeconds: null, coverageNotes: notes };
}

/** Default for every registry entry: researched, not integrated. */
export class NotIntegratedAdapter implements TicketSourceAdapter {
  readonly implementation = 'not_integrated';
  readonly capabilities: readonly Capability[] = [];
  constructor(readonly sourceId: string) {}
  async resolveEvent(_eventId: string): Promise<{ providerEventId: string | null; status: SourceStatus }> {
    return { providerEventId: null, status: 'not_integrated' };
  }
  async search(_input: SearchInput): Promise<SourceResult> {
    return result(this.sourceId, 'not_integrated', 'no_approved_access', ['Research candidate only; requires a staff manual check or an approved adapter.']);
  }
  async revalidate(_offerId: string, _input: SearchInput): Promise<SourceResult> {
    return result(this.sourceId, 'not_integrated', 'no_approved_access', []);
  }
}

/** Manual research path: the adapter itself never fetches; it records that a staffed check is pending. */
export class ManualAdapter implements TicketSourceAdapter {
  readonly implementation = 'manual';
  readonly capabilities: readonly Capability[] = ['quote_search', 'quote_revalidation'];
  constructor(readonly sourceId: string) {}
  async resolveEvent(_eventId: string): Promise<{ providerEventId: string | null; status: SourceStatus }> {
    return { providerEventId: null, status: 'manual_pending' };
  }
  async search(_input: SearchInput): Promise<SourceResult> {
    return result(this.sourceId, 'manual_pending', 'staff_check_required', ['Manual staff check required; results are entered with evidence in the review console.']);
  }
  async revalidate(_offerId: string, _input: SearchInput): Promise<SourceResult> {
    return result(this.sourceId, 'manual_pending', 'staff_revalidation_required', []);
  }
}

/**
 * Fixture adapter: serves clearly-marked synthetic offers from an in-memory fixture set for local demos and
 * tests. Every offer has collectionMode 'fixture', which the send gate rejects (A13/A65).
 */
export class FixtureAdapter implements TicketSourceAdapter {
  readonly implementation = 'fixture';
  readonly capabilities: readonly Capability[] = ['event_lookup', 'quote_search', 'quote_revalidation', 'monitoring'];
  constructor(readonly sourceId: string, private readonly offersByEvent: Record<string, Offer[]>, private readonly behavior: { status?: SourceStatus; retryAfterSeconds?: number } = {}, private readonly clock: () => Date = () => new Date()) {}
  async resolveEvent(eventId: string): Promise<{ providerEventId: string | null; status: SourceStatus }> {
    return { providerEventId: this.offersByEvent[eventId] ? `fx-${eventId}` : null, status: this.offersByEvent[eventId] ? 'success' : 'no_matching_inventory' };
  }
  async search(input: SearchInput): Promise<SourceResult> {
    if (this.behavior.status && this.behavior.status !== 'success') {
      return { ...result(this.sourceId, this.behavior.status, this.behavior.status, ['Fixture-simulated source failure; not sold out.']), retryAfterSeconds: this.behavior.retryAfterSeconds ?? null };
    }
    const offers = (this.offersByEvent[input.eventId] ?? []).filter((o) => o.sourceId === this.sourceId).map((o) => OfferSchema.parse({ ...o, collectionMode: 'fixture', observedAt: this.clock().toISOString() }));
    return result(this.sourceId, offers.length ? 'success' : 'no_matching_inventory', null, ['FIXTURE DATA — synthetic offers for local demonstration only.'], offers);
  }
  async revalidate(offerId: string, input: SearchInput): Promise<SourceResult> {
    const r = await this.search(input);
    return { ...r, offers: r.offers.filter((o) => o.id === offerId) };
  }
}

/**
 * Ticketmaster Discovery v2: event/attraction/venue discovery only. It never yields purchasable offers —
 * event-level price ranges are NOT converted into quotes (A12). Disabled without key + terms clearance.
 */
export class TicketmasterDiscoveryAdapter implements TicketSourceAdapter {
  readonly sourceId = 'ticketmaster';
  readonly implementation = 'ticketmaster_discovery';
  readonly capabilities: readonly Capability[] = ['discovery', 'event_lookup'];
  constructor(private readonly apiKey: string | null, private readonly enabled: boolean, private readonly fetchImpl: typeof fetch = fetch) {}
  async resolveEvent(_eventId: string): Promise<{ providerEventId: string | null; status: SourceStatus }> {
    if (!this.enabled) return { providerEventId: null, status: 'access_not_approved' };
    if (!this.apiKey) return { providerEventId: null, status: 'not_configured' };
    return { providerEventId: null, status: 'not_supported' }; // event mapping happens via discoverEvents + staff confirmation
  }
  async search(_input: SearchInput): Promise<SourceResult> {
    return result(this.sourceId, 'not_supported', 'discovery_is_not_listing_level', ['Ticketmaster Discovery returns events and price ranges, not purchasable listings; no offers are produced from it.']);
  }
  async revalidate(_offerId: string, _input: SearchInput): Promise<SourceResult> {
    return result(this.sourceId, 'not_supported', 'discovery_is_not_listing_level', []);
  }
  /** Bounded discovery call (US only). Returns candidate events with official URLs; price ranges are dropped deliberately. */
  async discoverEvents(q: { keyword: string; city?: string | null; stateCode?: string | null; startDateTime?: string | null; endDateTime?: string | null }): Promise<{ status: SourceStatus; events: Array<{ providerEventId: string; name: string; url: string; localDate: string | null; localTime: string | null; venueName: string | null; timezone: string | null }> }> {
    if (!this.enabled) return { status: 'access_not_approved', events: [] };
    if (!this.apiKey) return { status: 'not_configured', events: [] };
    const params = new URLSearchParams({ apikey: this.apiKey, keyword: q.keyword, countryCode: 'US', size: '10', sort: 'date,asc' });
    if (q.city) params.set('city', q.city);
    if (q.stateCode) params.set('stateCode', q.stateCode);
    if (q.startDateTime) params.set('startDateTime', q.startDateTime);
    if (q.endDateTime) params.set('endDateTime', q.endDateTime);
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch {
      return { status: 'timeout', events: [] };
    }
    if (res.status === 429) return { status: 'rate_limited', events: [] };
    if (res.status === 401 || res.status === 403) return { status: 'access_not_approved', events: [] };
    if (!res.ok) return { status: 'provider_error', events: [] };
    const json = (await res.json()) as { _embedded?: { events?: Array<Record<string, unknown>> } };
    const events = (json._embedded?.events ?? []).map((e) => {
      const dates = (e.dates as { start?: { localDate?: string; localTime?: string }; timezone?: string } | undefined) ?? {};
      const venues = ((e._embedded as { venues?: Array<{ name?: string }> } | undefined)?.venues ?? []) as Array<{ name?: string }>;
      return {
        providerEventId: String(e.id),
        name: String(e.name ?? ''),
        url: String(e.url ?? ''),
        localDate: dates.start?.localDate ?? null,
        localTime: dates.start?.localTime ?? null,
        venueName: venues[0]?.name ?? null,
        timezone: dates.timezone ?? null,
      };
    });
    return { status: 'success', events };
  }
}

export function buildAdapter(activation: AdapterActivation, deps: { fixtureOffers: Record<string, Offer[]>; fixtureBehavior?: Record<string, { status?: SourceStatus; retryAfterSeconds?: number }>; ticketmasterKey: string | null; ticketmasterEnabled: boolean; now?: () => Date }): TicketSourceAdapter {
  if (!activation.enabled) return new NotIntegratedAdapter(activation.sourceId);
  switch (activation.implementation) {
    case 'fixture':
      return new FixtureAdapter(activation.sourceId, deps.fixtureOffers, deps.fixtureBehavior?.[activation.sourceId], deps.now);
    case 'manual':
      return new ManualAdapter(activation.sourceId);
    case 'ticketmaster_discovery':
      return new TicketmasterDiscoveryAdapter(deps.ticketmasterKey, deps.ticketmasterEnabled);
    default:
      return new NotIntegratedAdapter(activation.sourceId);
  }
}
