import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { areaIntent, chooseShownOffer, fieldsFromRead, type ListingRead, type ListingReader } from '@/lib/ai/listing-evidence';
import { buildPacket, type BuildPacketArgs, type SubjectListing } from '@/lib/advice/packet';
import { renderEvidenceOnly } from '@/lib/advice/renderer';
import type { MarketContext } from '@/lib/market/series';

/**
 * Fix verification, Oct 2 2026 (deployed e2e42d5, real Gmail, six sends): the morning fixes held, and three things
 * didn't. FV-R2-01: "We don't need the floor — what's the cheapest option for two?" still chose the $107.33 floor row
 * over the $100.17 balcony row. FV-R2-02: every reply ended "Is $107.33 the price per ticket, or for all 2?" after
 * saying "$214.66 for two", even once the customer had written "each". FV-R2-03: the follow-up repeated the row,
 * a 19-hour-old venue-wide gap and the whole market section after its answer (468 words). The live model's rows came
 * back with no per-ticket label, which is what the readers here return.
 */
type Row = NonNullable<ListingRead['offers']>[number];
const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
const row = (label: string, price: number, listingType: Row['listingType']): Row => ({ label, priceDollars: price, priceBasis: 'unknown', feeBasis: 'all_in', listingType, admission: 'standing' });
/** The morning screenshot (08:21 EDT) and the fresh one (17:13Z), as evidence/REGRESSION_INPUT.json and FRESH_SCREENSHOT_OBSERVATION.json record them. */
const MORNING = [row('Balcony: Standing Room Only', 100.17, 'resale'), row('Balcony: Standing Room Only', 104, 'primary'), row('GA Ticket Price Tier 2: While Supplies Last', 107.33, 'resale')];
const FRESH = [row('Balcony: Standing Room Only', 104, 'primary'), row('GA Ticket Price Tier 3: While Supplies Last', 113.29, 'resale'), row('GA Ticket Price Tier 2: While Supplies Last', 118.06, 'resale')];
const read = (offers: Row[]): ListingRead => ({ ...blank, kind: 'ticket_listing', confidence: 'high', seller: 'Ticketmaster', eventName: 'jigitz', eventDate: '2026-10-02', eventTime: '20:00', venue: 'Brooklyn Paramount', city: 'Brooklyn', quantity: 2, feeBasis: 'all_in', beforeTaxes: true, doorsTime: '20:00', showTime: '21:00', offers, restrictions: ['Standing Room Only', 'While Supplies Last'] });

const C02 = [
  "Hey, is this worth it for two of us tonight, or can you find cheaper? We'd rather be on the floor.\n\nhttps://www.ticketmaster.com/jigitz-brooklyn-new-york-10-02-2026/event/000064BDD0EBAA37",
  "It's standing room — we just want two floor tickets. The screenshot says $107.33 each including fees before taxes. Would you buy those or wait until later today?",
];
const C03 = "We don't need the floor — what's the cheapest option for two in this screenshot?\n\nhttps://www.ticketmaster.com/jigitz-brooklyn-new-york-10-02-2026/event/000064BDD0EBAA37";
const C04 = "Hey, this is the screenshot I just took for two tickets tonight. We'd rather be on the floor. Which option would you pick, and what would it cost for both of us?\n\nhttps://www.ticketmaster.com/jigitz-brooklyn-new-york-10-02-2026/event/000064BDD0EBAA37";

describe('FV-R2-01: what they said about an area', () => {
  it('wanted, not needed, fine, or ruled out; the latest word wins', () => {
    expect(areaIntent("We'd rather be on the floor.")).toEqual({ want: 'floor', excluded: new Set() });
    expect(areaIntent("We don't need the floor — what's the cheapest option for two?")).toEqual({ want: null, excluded: new Set() });
    expect(areaIntent('floor not required')).toEqual({ want: null, excluded: new Set() });
    expect(areaIntent('No floor please, cheapest for two')).toEqual({ want: null, excluded: new Set(['floor']) });
    expect(areaIntent("Floor if we can, but the balcony is fine.")).toEqual({ want: 'floor', excluded: new Set() });
    expect(areaIntent("We'd rather not be on the floor.")).toEqual({ want: null, excluded: new Set(['floor']) });
    expect(areaIntent("Not sure, maybe the floor?")).toEqual({ want: 'floor', excluded: new Set() });
    // A later message changes it: floor first, then "we don't need the floor after all".
    expect(areaIntent("We'd rather be on the floor.\nActually we don't need the floor after all.")).toEqual({ want: null, excluded: new Set() });
  });

  it('price first when the area is not needed; the floor still wins when it is cheapest; "no floor" excludes it', () => {
    const pick = (offers: Row[], said: string) => chooseShownOffer(fieldsFromRead(read(offers)), said);
    expect(pick(MORNING, C03)).toMatchObject({ section: 'Balcony: Standing Room Only', perTicketCents: 10017, wholePartyCents: 20034, chosenFor: null, priceBasis: 'per_ticket' });
    const floorCheapest = [row('Balcony: Standing Room Only', 110, 'resale'), row('GA Ticket Price Tier 1', 95, 'resale')];
    expect(pick(floorCheapest, C03)).toMatchObject({ section: 'GA Ticket Price Tier 1', perTicketCents: 9500 });
    expect(pick(floorCheapest, 'No floor, cheapest for two')).toMatchObject({ section: 'Balcony: Standing Room Only', perTicketCents: 11000 });
    // The positive preference is unchanged: the floor row, and the cheaper floor tier on the fresh page.
    expect(pick(MORNING, C02[0]!)).toMatchObject({ perTicketCents: 10733, chosenFor: 'floor' });
    expect(pick(FRESH, C04)).toMatchObject({ section: 'GA Ticket Price Tier 3: While Supplies Last', perTicketCents: 11329, wholePartyCents: 22658, chosenFor: 'floor' });
  });
});

/** The packet as the live replies had it: the venue-wide market from 19 hours before, shown. */
describe('FV-R2-02/03: the reply around the row, with the live market', () => {
  const at = new Date('2026-10-02T17:28:25Z');
  const market = { methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 8195, at: new Date('2026-10-01T22:09:00Z'), activeListings: 52 }, h24: null, h72: { hours: 72, fromCents: 6844, toCents: 8195, changeCents: 1351, pct: 0.2 }, direction: 'up', supply: { trend: 'shrinking', now: 52, before: 86, hours: 72 }, typical: null, points: 12 } as unknown as MarketContext;
  const subject = (offers: Row[], said: string, quoted: number | null = null): SubjectListing => ({ ...chooseShownOffer(fieldsFromRead(read(offers)), said, quoted), source: 'screenshot', observedAt: at, confidence: 'high' });
  const args = (sub: SubjectListing, over: Partial<BuildPacketArgs> = {}) => ({
    requestId: 'r', revision: 1, quantity: 2, eventLabel: 'jigitz', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false },
    sourcesChecked: ['seatdata'], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    market: { basis: 'pair', context: market, supply: market.supply, supplyScope: 'all', comparableLabel: null, visible: true },
    official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/000064BDD0EBAA37' }, faceValue: null,
    subject: sub, quote: { perTicketCents: sub.perTicketCents!, assumedPerTicket: sub.priceBasis === 'unknown', source: 'screenshot', feeBasis: sub.feeBasis, seenAt: at, seller: 'Ticketmaster' },
    seatingPreference: 'floor', timeZone: 'America/New_York', eventLocalDate: '2026-10-02', eventStartAt: new Date('2026-10-03T01:00:00Z'), eventNoun: 'show',
    ...over,
  }) as unknown as BuildPacketArgs;
  const body = (a: BuildPacketArgs) => renderEvidenceOnly(buildPacket(a)).textBody.split('\nTicket Guy\n')[0]!;
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

  it('C03: the cheapest row leads, with what the floor would add; nothing asks per ticket or for all', () => {
    const text = body(args(subject(MORNING, `floor not required\n${C03}`), { seatingPreference: 'floor not required' }));
    expect(text).toContain('jigitz · 2 tickets\n\nThe cheapest option in your screenshot is “Balcony: Standing Room Only”, a resale ticket, at $100.17 a ticket including fees, before taxes: $200.34 for two. The cheapest floor option, “GA Ticket Price Tier 2: While Supplies Last”, is $14.32 more for two.');
    expect(text).not.toMatch(/per ticket, or for all|\$25\.38|\$18\.41/);
  });

  it('C04: the cheaper floor tier, its total, and what it costs over the balcony', () => {
    const text = body(args(subject(FRESH, C04)));
    expect(text).toContain('The floor option in your screenshot is “GA Ticket Price Tier 3: While Supplies Last”, a resale ticket, at $113.29 a ticket including fees, before taxes: $226.58 for two. That’s $18.58 more for two than the cheapest balcony option, “Balcony: Standing Room Only” at $104 a ticket.');
    expect(text).not.toMatch(/per ticket, or for all|\$31\.34/);
    // A venue-wide floor from hours ago isn't a comparison for rows on one page; the page's own rows are (post-deploy
    // QA Oct 2, PD-R2-02: it padded the first reply).
    expect(text).not.toMatch(/about 19 hours ago|resale market when I last checked|\$81\.95/);
  });

  it('C02 opening: one row, its total, the trade-off; the age-stamped market below; no basis question', () => {
    const text = body(args(subject(MORNING, C02[0]!)));
    expect(text).toContain('That’s $14.32 more for two than the cheapest balcony option');
    expect(text).not.toMatch(/per ticket, or for all|\$25\.38 a ticket above/);
  });

  it('C02 follow-up: the answer, the rows and the checks; not the row, face value and market again', () => {
    const sub = subject(MORNING, `${C02[0]}\n${C02[1]}`, 10733);
    expect(sub.priceBasis).toBe('per_ticket');
    const text = body(args(sub, { revision: 2, trendAsked: { noAlerts: false, riskOk: false } }));
    expect(text.split('\n\n')[2]).toMatch(/^If \$214\.66 for two \(with fees and before taxes\) works for you and the floor is what you want, I’d buy rather than wait\./);
    expect(text).toContain('$14.32 less for two');
    expect(text).not.toMatch(/The floor option in your screenshot|isn’t face value|The resale market when I last checked|Lowest asking price|per ticket, or for all|\$25\.38/);
    expect(words(text)).toBeLessThan(260);
  });
});

/** C03 through the real intake and reply path, with the rows read as the live model read them. */
describe('FV-R2-01/02 replayed', () => {
  let h: DbHandle;
  class Reader implements ListingReader {
    readonly name = 'fake';
    constructor(private readonly offers: Row[]) {}
    async read(input: { image?: unknown }): Promise<ListingRead> {
      return input.image ? read(this.offers) : blank;
    }
  }
  const send = async (text: string, offers: Row[], from: string) => {
    const now = new Date('2026-10-02T17:25:00Z');
    const c = makeConcierge(h, { now: () => now, listingReader: new Reader(offers) });
    const jpg = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } }).jpeg().toBuffer());
    await c.ingestInbound(inbound({ text, from, subject: 'Tickets', receivedAt: now, attachments: [{ providerAttachmentId: `att-${from}`, filename: 'jigitz.jpg', declaredMimeType: 'image/jpeg', bytes: jpg, inline: false }] }));
    for (let j = 0; j < 8; j++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(now.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    }
    const recs = await h.db.select().from(t.recommendations);
    return recs.at(-1)!.bodyText.split('\nTicket Guy\n')[0]!;
  };

  beforeAll(async () => {
    h = await openTestDb();
    const [v] = await h.db.insert(t.venues).values({ name: 'Brooklyn Paramount', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.6904, longitude: -73.9836 }).returning();
    const [a] = await h.db.insert(t.entities).values({ kind: 'artist', name: 'jigitz', slug: 'jigitz-fv', aliases: [] }).returning();
    const [e] = await h.db.insert(t.events).values({ name: 'jigitz', genre: 'dance/electronic / house', category: 'concert', venueId: v!.id, primaryEntityId: a!.id, localStartAt: new Date('2026-10-03T00:00:00Z'), status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster', saleStatus: 'onsale' }).returning();
    await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: '000064BDD0EBAA37', authoritativeUrl: 'https://www.ticketmaster.com/event/000064BDD0EBAA37', role: 'discovery', confidence: 'provider_id' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('C03 exact: the $100.17 balcony row for two, and no "per ticket, or for all 2?"', async () => {
    const text = await send(C03, MORNING, 'fv-c03@customer.example');
    expect(text).toContain('The cheapest option in your screenshot is “Balcony: Standing Room Only”, a resale ticket, at $100.17 a ticket including fees, before taxes: $200.34 for two. The cheapest floor option, “GA Ticket Price Tier 2: While Supplies Last”, is $14.32 more for two.');
    expect(text).not.toMatch(/per ticket, or for all|The floor option/);
  });

  it('C04 exact: the Tier 3 floor row, $226.58 for two, and no basis question', async () => {
    const text = await send(C04, FRESH, 'fv-c04@customer.example');
    expect(text).toContain('The floor option in your screenshot is “GA Ticket Price Tier 3: While Supplies Last”, a resale ticket, at $113.29 a ticket including fees, before taxes: $226.58 for two.');
    expect(text).not.toMatch(/per ticket, or for all/);
  });
});
