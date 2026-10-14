import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runThread } from '../../evals/harness';
import { productionScenario } from '../../evals/production';
import { EV, seedWorld, worldOffers } from '../../evals/world';
import { openTestDb } from '../harness';
import * as t from '@/lib/db/schema';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';

/**
 * A production thread, replayed (evals/production.ts). The record is built from the eval world's Rangers game, then
 * given fresh ids as if it came from the production database, so the replay must seed its own catalog slice (with the
 * team already in the fixture catalog keeping its id) and serve the recorded listing, with no eval world at all.
 */
async function fakeRecord() {
  const h = await openTestDb();
  try {
    await seedWorld(h.db);
    const [event] = await h.db.select().from(t.events).where(eq(t.events.id, EV.rangersBruins));
    const venues = await h.db.select().from(t.venues).where(eq(t.venues.id, event!.venueId!));
    const entities = await h.db.select().from(t.entities).where(inArray(t.entities.id, [event!.primaryEntityId, event!.opponentEntityId].filter(Boolean) as string[]));
    const zones = await h.db.select().from(t.venueSeatZones).where(eq(t.venueSeatZones.venueId, event!.venueId!));
    const ids = new Map<string, string>();
    const fresh = (id: string) => ids.get(id) ?? (ids.set(id, randomUUID()), ids.get(id)!);
    const listing = worldOffers()[EV.rangersBruins]!.find((o) => o.quantity === 4)!;
    const offerId = randomUUID();
    const at = '2026-10-19T14:15:00.000Z';
    const json = <T>(x: T): T => JSON.parse(JSON.stringify(x));
    return json({
      conversationId: randomUUID(), subject: 'Rangers',
      inbound: [{ at, subject: 'Rangers', text: 'hey looking for rangers tix this thursday, 4 of us', images: [] }],
      sent: [{ at, cls: 'recommendation', subject: 'Re: Rangers', text: 'what we sent then', state: 'delivered' }],
      world: {
        venues: venues.map((v) => ({ ...v, id: fresh(v.id) })),
        entities: entities.map((e) => ({ ...e, id: fresh(e.id), homeVenueId: e.homeVenueId ? fresh(e.homeVenueId) : null })),
        events: [{ ...event!, id: fresh(event!.id), venueId: fresh(event!.venueId!), primaryEntityId: event!.primaryEntityId ? fresh(event!.primaryEntityId) : null, opponentEntityId: event!.opponentEntityId ? fresh(event!.opponentEntityId) : null }],
        mappings: [],
        zones: zones.map((z) => ({ ...z, id: randomUUID(), venueId: fresh(z.venueId) })),
        offers: [{ id: offerId, sourceId: 'seatdata', providerListingId: 'L1', eventId: fresh(event!.id), sellerName: null, directPurchaseUrl: 'https://real-marketplace.example/checkout/L1', affiliateUrl: null, lifecycle: 'active', createdAt: at }],
        observations: [{ id: randomUUID(), offerId, runId: null, checkId: null, eventId: fresh(event!.id), quantity: 4, section: listing.section, rowLabel: listing.row, seatNumbers: null, seatsTogether: true, admissionType: 'reserved', baseTotalCents: 43000, mandatoryFeeTotalCents: 7000, taxTotalCents: 0, deliveryTotalCents: 0, payableTotalCents: 50000, priceCompleteness: 'verified_total', restrictions: [], deliveryMethod: 'mobile_transfer', expectedDeliveryAt: null, availability: 'available', verificationMethod: 'approved_api', verifiedBy: null, sourceAsOf: at, fetchedAt: at, retentionUntil: null, evidence: null }],
      },
    });
  } finally {
    await h.close();
  }
}

describe('production threads replay against their own catalog slice', () => {
  it('seeds the recorded event and listing, answers from them, and never links to the real checkout', async () => {
    const s = productionScenario(await fakeRecord());
    expect(s.world).toBe('none');
    expect(s.groundedCents).toContain(50000);
    const [turn] = await runThread(s, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter() });
    expect(turn!.reply).toMatch(/\$500/);
    expect(turn!.reply).not.toMatch(/real-marketplace\.example/);
  }, 90_000);
});
