import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, testEnv } from '../harness';
import { chooseShownOffer, fieldsFromRead, type ListingRead } from '@/lib/ai/listing-evidence';
import { buildPacket, type BuildPacketArgs, type SubjectListing } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { questionsAsked, TREND_ASKED } from '@/lib/intake/pipeline';
import { MarketTracker } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import type { MarketContext } from '@/lib/market/series';

/**
 * Post-deploy QA, Oct 2 2026 (build b31b3fc, real Gmail and captured replies). PD-R2-01: the later jigitz screenshot
 * was read as "jיגitz", and the reply said "I wouldn't buy this one as it stands: it's for jיגitz, not jigitz".
 * PD-R1-02: "Can you find a cheaper pair for the same game? … are prices generally going down or up?" got the first
 * reply's ask again and neither answer. PD-R2-02: the first screenshot replies carried a 21-hour-old venue-wide
 * market block. PD-R1-01: a listing link read that never happened left no trace of why.
 */
const at = new Date('2026-10-02T18:50:00Z');
const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
const fresh = (eventName: string): SubjectListing => ({
  ...chooseShownOffer(fieldsFromRead({
    ...blank, kind: 'ticket_listing', confidence: 'medium', seller: 'Ticketmaster', eventName, eventDate: '2026-10-02', eventTime: '20:00', venue: 'Brooklyn Paramount', city: 'Brooklyn', quantity: 2, feeBasis: 'all_in', beforeTaxes: true, doorsTime: '20:00', showTime: '21:00',
    unreadable: ['Only 3 of the 7 results are visible.'],
    offers: [
      { label: 'Balcony: Standing Room Only', priceDollars: 104, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'primary', admission: 'standing' },
      { label: 'GA Ticket Price Tier 3: While Supplies Last', priceDollars: 113.29, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'resale', admission: 'standing' },
      { label: 'GA Ticket Price Tier 2: While Supplies Last', priceDollars: 118.06, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'resale', admission: 'standing' },
    ],
  }), 'Two of us would rather be on the floor.\nfloor'),
  source: 'screenshot', observedAt: at, confidence: 'medium',
});
const market: MarketContext = { methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 8195, at: new Date('2026-10-01T22:09:00Z'), activeListings: 52 }, h24: null, h72: { hours: 72, fromCents: 6844, toCents: 8195, changeCents: 1351, pct: 0.2 }, direction: 'up', supply: { trend: 'shrinking', now: 52, before: 86, hours: 72 }, typical: null, points: 10 } as unknown as MarketContext;
const base = (over: Partial<BuildPacketArgs>) => ({
  requestId: 'r', revision: 1, quantity: 2, eventLabel: 'jigitz', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
  policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
  priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false },
  sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
  market: null, official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/000064BDD0EBAA37' }, faceValue: null, subject: null, quote: null,
  timeZone: 'America/New_York', eventNoun: 'show',
  ...over,
}) as unknown as BuildPacketArgs;
const render = async (a: BuildPacketArgs) => {
  const packet = buildPacket(a);
  const r = validateAndRender(packet, await new FixtureDrafter().draft(packet, { quantity: 2, togetherRequired: false } as never));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.textBody.split('\nTicket Guy\n')[0]!;
};
const jigitz = (eventName: string) => {
  const sub = fresh(eventName);
  return base({
    subject: sub, quote: { perTicketCents: sub.perTicketCents!, assumedPerTicket: false, source: 'screenshot', feeBasis: sub.feeBasis, seenAt: at, seller: 'Ticketmaster' },
    eventIdentity: { names: ['jigitz'], nicknames: [], venueNames: ['Brooklyn Paramount'], city: 'Brooklyn' },
    market: { basis: 'pair', context: market, supply: market.supply, supplyScope: 'all', comparableLabel: null, visible: true },
    sourcesChecked: ['seatdata'], seatingPreference: 'floor', eventLocalDate: '2026-10-02', eventStartAt: new Date('2026-10-03T01:00:00Z'),
  });
};

describe('PD-R2-01: a misread name on the right show is not another show', () => {
  it('"jיגitz" at Brooklyn Paramount on Oct 2 is jigitz: the floor row, no "not jigitz", no advice against it', async () => {
    const text = await render(jigitz('jיגitz'));
    expect(text).toContain('The floor option in your screenshot is “GA Ticket Price Tier 3: While Supplies Last”, a resale ticket, at $113.29 a ticket including fees, before taxes: $226.58 for two.');
    expect(text).not.toMatch(/not jigitz|I wouldn’t buy this one|right show/);
  });

  it('a one-letter slip on the same date and venue is the same show; a different act in full still is not', async () => {
    expect(await render(jigitz('jigits'))).not.toMatch(/not jigitz/);
    const other = await render(jigitz('Fred again..'));
    expect(other).toContain('The listing is for Fred again.., not jigitz. Make sure it’s the right show.');
  });
});

describe('PD-R2-02: a results page’s first reply is the rows, not a stale venue-wide market', () => {
  it('no market block, no "cheapest listing I can see", no "couldn’t read everything" for rows below the fold', async () => {
    const text = await render(jigitz('jigitz'));
    expect(text).not.toMatch(/resale market when I last checked|cheapest listing I can see|\$81\.95|Those figures|couldn’t read everything/);
    expect(text).toContain('That’s $18.58 more for two than the cheapest balcony option');
  });
});

describe('PD-R1-02: the Rangers follow-up gets both of its questions answered', () => {
  const follow = 'Can you find a cheaper pair for the same game? Nothing fancy, we just want to sit together. And if you can’t see that exact listing, are prices generally going down or up?';

  it('reads the two questions it asks', () => {
    expect(questionsAsked(follow).cheaper).toBe(true);
    expect(TREND_ASKED.test(follow)).toBe(true);
    expect(questionsAsked('Is this a good deal for two or should I hold off?').cheaper).toBe(false);
    expect(TREND_ASKED.test('Is the price going up?')).toBe(true);
  });

  it('with no listings to look through: says it can’t look for a cheaper pair, answers on the trend, and asks once', async () => {
    const text = await render(base({
      eventLabel: 'New York Rangers vs. New York Islanders', eventNoun: 'game', link: { marketplace: 'StubHub', eventPage: false },
      asks: { ...questionsAsked(follow) }, trendAsked: { noAlerts: false, riskOk: false }, priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
      eventLocalDate: '2026-10-06', eventStartAt: new Date('2026-10-06T23:30:00Z'),
    }));
    expect(text).toContain('I don’t have a supported price trend for two seats together at this game, so I can’t tell you whether prices are rising or falling');
    expect(text).toContain('I can’t see resale listings for this game right now, so I can’t look for a cheaper pair myself. If you find one, or want me to check the one you picked, send its price for two with fees and its section and row (a screenshot works), and I’ll compare.');
    expect(text).not.toMatch(/doesn’t pass me the price/);
    expect(text.match(/screenshot/g)).toHaveLength(1);
  });
});

describe('PD-R1-01: a listings read that doesn’t happen says why', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  const EVENT = '30000000-0000-4000-8000-0000000000a1';
  const reads = async () => (await h.db.select().from(t.marketFetches).where(eq(t.marketFetches.eventId, EVENT))).map((r) => `${r.status}:${r.detail}`);

  it('the licence, then an event with no SeatData match and no StubHub id, each leaves a skipped row', async () => {
    const tracker = () => new MarketTracker({ db: h.db, env: testEnv({ SEATDATA_API_KEY: 'ab'.repeat(32) }), now: () => at, fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
    await h.db.insert(t.venues).values({ id: '10000000-0000-4000-8000-0000000000a1', name: 'Probe Arena', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' }).onConflictDoNothing();
    await h.db.insert(t.events).values({ id: EVENT, name: 'Probe Game', category: 'nhl', venueId: '10000000-0000-4000-8000-0000000000a1', localStartAt: new Date('2026-10-06T23:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true }).onConflictDoNothing();
    expect(await tracker().currentListings(EVENT)).toBeNull();
    expect((await reads()).at(-1)).toMatch(/^skipped:licence_not_approved_for_tracking/);
    await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    expect(await tracker().currentListings(EVENT)).toBeNull();
    expect((await reads()).at(-1)).toBe('skipped:not_tracked_no_stubhub_id');
  });
});
