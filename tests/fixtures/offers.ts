import type { Offer } from '@/lib/domain/types';

export const FIXTURE_EVENT_ID = '00000000-0000-4000-8000-00000000e001';
export const OTHER_EVENT_ID = '00000000-0000-4000-8000-00000000e002';

let n = 0;
/** Builds a synthetic, clearly-marked fixture offer. Never used in live sends. */
export function fixtureOffer(over: Partial<Offer> = {}): Offer {
  n += 1;
  return {
    id: over.id ?? `fixture-offer-${n}`,
    sourceId: 'fixture-source',
    providerListingId: null,
    eventId: FIXTURE_EVENT_ID,
    observedAt: '2026-09-22T15:00:00.000Z',
    providerUpdatedAt: null,
    expiresAt: null,
    quantity: 2,
    currency: 'USD',
    baseTotalCents: 20000,
    mandatoryFeeTotalCents: 4000,
    taxTotalCents: 0,
    deliveryTotalCents: 0,
    payableTotalCents: 24000,
    priceCompleteness: 'verified_total',
    section: '212',
    row: 'C',
    seatNumbers: null,
    seatsTogether: true,
    admissionType: 'reserved',
    restrictions: [],
    deliveryMethod: 'mobile_transfer',
    expectedDeliveryAt: null,
    directPurchaseUrl: 'https://example.invalid/fixture/offer',
    affiliateUrl: null,
    affiliateCommissionBps: 0,
    evidenceId: `fixture-evidence-${n}`,
    collectionMode: 'fixture',
    availability: 'available',
    seatClass: 'upper',
    ...over,
  };
}
