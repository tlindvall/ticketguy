import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX, FIXTURE_NOW } from '@/lib/fixtures';
import type { Offer } from '@/lib/domain/types';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { openTestDb, inbound, testEnv } from '../harness';

/**
 * The review's core acceptance case (TGQA-0929 remediation review, "Useful comparisons"): the customer's own
 * offer against suitable alternatives for the same brief. Synthetic, deterministic, not real inventory.
 *   Customer's offer: five together, $650 confirmed total (over the $600 cap).
 *   B: exactly five together, comparable, $585 verified total: recommended, $65 less.
 *   C: five for $500, obstructed view: rejected, never offered because it's cheaper.
 *   D: a six-ticket listing at $95 a seat, split and charges unknown: not a five-seat offer, not "$475".
 * A second world has only C and D: the answer is a stated limit and a next step, not an invented winner.
 */
const EV = FX.events.rangersPreseason;
const base = (over: Partial<Offer> & { id: string; quantity: number; payableTotalCents: number | null }): Offer => ({
  sourceId: FX.source, providerListingId: over.id, eventId: EV, observedAt: FIXTURE_NOW.toISOString(), providerUpdatedAt: null, expiresAt: null, currency: 'USD',
  baseTotalCents: null, mandatoryFeeTotalCents: null, taxTotalCents: null, deliveryTotalCents: null, priceCompleteness: 'verified_total',
  section: null, row: null, seatNumbers: null, seatsTogether: true, admissionType: 'reserved', restrictions: [], deliveryMethod: 'mobile_transfer', expectedDeliveryAt: null,
  directPurchaseUrl: `https://example.invalid/fixture/${over.id}`, affiliateUrl: null, affiliateCommissionBps: 0, evidenceId: `fx-ev-${over.id}`, collectionMode: 'fixture', availability: 'available', seatClass: 'upper', ...over,
});
const B = base({ id: 'b-5-212', quantity: 5, payableTotalCents: 58500, section: '212', row: 'C' });
const C = base({ id: 'c-5-227-obstructed', quantity: 5, payableTotalCents: 50000, section: '227', row: 'A', restrictions: ['obstructed_view'] });
const D = base({ id: 'd-6-218', quantity: 6, payableTotalCents: null, baseTotalCents: 57000, priceCompleteness: 'incomplete', section: '218', row: 'B' });

const read: ListingRead = { kind: 'ticket_listing', sensitiveContent: false, seller: 'StubHub', eventName: null, eventDate: '2026-10-03', venue: null, city: null, quantity: 5, priceText: '$650 total incl. fees', priceDollars: 650, priceBasis: 'whole_party', feeBasis: 'all_in', totalDollars: 650, section: '214', row: 'D', seatNumbers: ['1', '2', '3', '4', '5'], seatsTogether: true, restrictions: [], deliveryText: 'Mobile transfer', deliveryBy: '2026-10-02', includedBenefits: [], confidence: 'high', unreadable: [] };
const reader: ListingReader = { name: 'fake', read: async () => read };

async function run(h: DbHandle, offers: Offer[], from: string, text = 'Rangers Oct 3, five together, $600 total including fees, no obstructed views. Found this on StubHub: Sec 214 Row D seats 1-5, $650 total incl fees. Is there a better option?') {
  const c = new Concierge({ db: h.db, env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: from }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: null, fixtureOffers: { [EV]: offers }, listingReader: reader });
  const r = (await c.ingestInbound(inbound({ text, from, subject: 'Rangers for five' }))) as { requestId: string };
  for (let i = 0; i < 10; i++) {
    const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
    if (!leased.length) break;
    for (const ev of leased) {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
  }
  const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
  if (!rec) {
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    const tr = await h.db.select().from(t.requestTransitions).where(eq(t.requestTransitions.requestId, r.requestId));
    throw new Error(`no recommendation: ${req?.state} ${JSON.stringify(tr.map((x) => x.reason))} ${sends.map((x) => x.bodyText).join('\n---\n')}`);
  }
  return rec.bodyText;
}

describe('useful comparisons: their offer against suitable alternatives', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('recommends the suitable cheaper option, says their offer is over the cap, and rejects the obstructed and six-ticket ones', async () => {
    const body = await run(h, [B, C, D], 'compare@customer.example');
    // Their offer: over the cap, never called a fit. B: recommended, with the whole-party total and the saving.
    expect(body.split('\n\n')[2]).toBe('I wouldn’t buy this one as it stands: it’s over your $600 budget. The verified option below meets what you asked for: $585 for all five, within your $600 and $65 less than this one.');
    expect(body).toContain('5 seats together in section 212: $585 total ($117 each)');
    // C and D: named as left out, with why, never offered or priced as a five-seat option.
    expect(body).toContain('I left out two cheaper listings: one has an obstructed view, which you ruled out; and one is a block of 6 that may not sell as exactly 5, with its charges unknown.');
    // ($475 appears in this fixture world's seeded price history, not as offer D.)
    expect(body).not.toMatch(/\$500|section 227|section 218|\$570/);
  });

  it('with nothing suitable, it says so and gives a next step instead of a winner', async () => {
    const body = await run(h, [C, D], 'compare-none@customer.example');
    expect(body.split('\n\n')[2]).toBe('I wouldn’t buy this one as it stands: it’s over your $600 budget.');
    expect(body).toContain('I haven’t found a verified alternative I can link you to yet, with a checked all-in price.');
    expect(body).toContain('I left out two cheaper listings');
    expect(body).not.toMatch(/\$500|section 227|section 218|\$570|Best verified option/);
  });

  it('B7 from research: a cheaper verified offer rejected for a flaw they ruled out is named and weighed against theirs, all-in both', async () => {
    // Oct 10 review: the pipeline never passed the rejected offer's total, so this verdict could not be sent; and when it
    // could, it said "the alternative saves $150" about an offer the email never described.
    const body = await run(h, [C], 'compare-flawed@customer.example', 'Rangers Oct 3, five together, no obstructed views. Found this on StubHub: Sec 214 Row D seats 1-5, $650 total incl fees. Is there a better option?');
    expect(body).toContain('I’d keep your original five tickets. The verified five tickets I found in section 227, row A are $150 less with fees, but they have a limited or obstructed view. Even for that saving, your seats are the better choice.');
    // Said once: the left-out line would only repeat it.
    expect(body).not.toContain('I left out');
  });
});
