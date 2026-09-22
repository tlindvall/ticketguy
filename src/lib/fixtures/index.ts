import type { Offer } from '@/lib/domain/types';

/**
 * Synthetic fixtures. Every ID is fixed so demos and tests are reproducible. Every offer is collectionMode
 * 'fixture' and every event/snapshot is isFixture=true; the send gate and benchmark refuse them outside
 * fixture mode (A13/A65). Prices are invented and are NOT real market data.
 */
export const FX = {
  venues: {
    msg: '10000000-0000-4000-8000-000000000001',
    barclays: '10000000-0000-4000-8000-000000000002',
    yankee: '10000000-0000-4000-8000-000000000003',
    scotiabank: '10000000-0000-4000-8000-000000000004',
  },
  entities: {
    rangers: '20000000-0000-4000-8000-000000000001',
    knicks: '20000000-0000-4000-8000-000000000002',
    yankees: '20000000-0000-4000-8000-000000000003',
    duaLipa: '20000000-0000-4000-8000-000000000004',
    leafs: '20000000-0000-4000-8000-000000000005',
    islanders: '20000000-0000-4000-8000-000000000006',
  },
  events: {
    rangersPreseason: '30000000-0000-4000-8000-000000000001',
    rangersRegular: '30000000-0000-4000-8000-000000000002',
    knicks: '30000000-0000-4000-8000-000000000003',
    yankees: '30000000-0000-4000-8000-000000000004',
    leafsToronto: '30000000-0000-4000-8000-000000000005',
  },
  dataset: '40000000-0000-4000-8000-000000000001',
  source: 'fixture-source',
  sourceB: 'fixture-source-b',
} as const;

/** Reference "now" for the fixture world: the research date. Tests pass a clock at or after this. */
export const FIXTURE_NOW = new Date('2026-09-22T15:00:00Z');
export const RANGERS_PRESEASON_START = new Date('2026-10-03T23:00:00Z'); // 7:00 PM ET

const url = (s: string) => `https://example.invalid/fixture/${s}`;

function offer(over: Partial<Offer> & { id: string; eventId: string; quantity: number; payableTotalCents: number | null }): Offer {
  return {
    sourceId: FX.source,
    providerListingId: over.id,
    observedAt: FIXTURE_NOW.toISOString(),
    providerUpdatedAt: null,
    expiresAt: null,
    currency: 'USD',
    baseTotalCents: over.payableTotalCents === null ? null : Math.round(over.payableTotalCents * 0.82),
    mandatoryFeeTotalCents: over.payableTotalCents === null ? null : over.payableTotalCents - Math.round(over.payableTotalCents * 0.82),
    taxTotalCents: 0,
    deliveryTotalCents: 0,
    priceCompleteness: 'verified_total',
    section: null,
    row: null,
    seatNumbers: null,
    seatsTogether: true,
    admissionType: 'reserved',
    restrictions: [],
    deliveryMethod: 'mobile_transfer',
    expectedDeliveryAt: null,
    directPurchaseUrl: url(over.id),
    affiliateUrl: null,
    affiliateCommissionBps: 0,
    evidenceId: `fx-ev-${over.id}`,
    collectionMode: 'fixture',
    availability: 'available',
    seatClass: 'upper',
    ...over,
  };
}

/** Offers by event ID, as the fixture adapter serves them. */
export const FIXTURE_OFFERS: Record<string, Offer[]> = {
  [FX.events.rangersPreseason]: [
    offer({ id: 'rp-5-upper-212', eventId: FX.events.rangersPreseason, quantity: 5, payableTotalCents: 42500, section: '212', row: 'C', seatClass: 'upper' }),
    offer({ id: 'rp-5-upper-224-unknown', eventId: FX.events.rangersPreseason, quantity: 5, payableTotalCents: 41000, section: '224', row: 'F', seatsTogether: null, seatClass: 'upper' }),
    offer({ id: 'rp-5-lower-110', eventId: FX.events.rangersPreseason, quantity: 5, payableTotalCents: 98000, section: '110', row: 'K', seatClass: 'lower' }),
    offer({ id: 'rp-5-upper-est', eventId: FX.events.rangersPreseason, quantity: 5, payableTotalCents: null, baseTotalCents: 36000, mandatoryFeeTotalCents: null, taxTotalCents: null, deliveryTotalCents: null, priceCompleteness: 'incomplete', section: '218', row: 'B', seatClass: 'upper', sourceId: FX.sourceB, directPurchaseUrl: url('rp-5-upper-est-b') }),
    offer({ id: 'rp-parking', eventId: FX.events.rangersPreseason, quantity: 5, payableTotalCents: 6000, restrictions: ['parking_only'], seatClass: 'other', admissionType: 'other' }),
    offer({ id: 'rp-1-upper-419', eventId: FX.events.rangersPreseason, quantity: 1, payableTotalCents: 3500, section: '419', row: 'J', seatClass: 'upper' }),
    offer({ id: 'rp-2-upper-208', eventId: FX.events.rangersPreseason, quantity: 2, payableTotalCents: 24000, section: '208', row: 'D', seatClass: 'upper' }),
    offer({ id: 'rp-2-upper-208-b', eventId: FX.events.rangersPreseason, quantity: 2, payableTotalCents: 24800, section: '208', row: 'D', seatClass: 'upper', sourceId: FX.sourceB, directPurchaseUrl: url('rp-2-upper-208-b') }),
    offer({ id: 'rp-2-obstructed', eventId: FX.events.rangersPreseason, quantity: 2, payableTotalCents: 15000, section: '227', row: 'A', restrictions: ['obstructed_view'], seatClass: 'upper' }),
  ],
  [FX.events.knicks]: [offer({ id: 'kn-2-upper-210', eventId: FX.events.knicks, quantity: 2, payableTotalCents: 31000, section: '210', row: 'E' })],
  [FX.events.yankees]: [offer({ id: 'yk-4-grandstand', eventId: FX.events.yankees, quantity: 4, payableTotalCents: 22000, section: '420b', row: '5' })],
  [FX.events.rangersRegular]: [offer({ id: 'rr-2-upper-215', eventId: FX.events.rangersRegular, quantity: 2, payableTotalCents: 36000, section: '215', row: 'B' })],
};

/** Twelve synthetic past Rangers home preseason games (2024–2025) for the benchmark cohort. */
export const FIXTURE_HISTORICAL_EVENTS = Array.from({ length: 12 }, (_, i) => {
  const year = i < 6 ? 2024 : 2025;
  const day = 20 + (i % 6);
  return {
    id: `31000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, '0')}`,
    name: `New York Rangers vs. Fixture Opponent ${i + 1} (preseason, ${year})`,
    localStartAt: new Date(`${year}-09-${day}T23:00:00Z`),
    fiveSeatBestCents: 37500 + i * 909,
  };
});
