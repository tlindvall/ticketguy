import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { chooseShownOffer, fieldsFromRead, type ListingRead, type ListingReader } from '@/lib/ai/listing-evidence';
import { buildPacket, type BuildPacketArgs, type SubjectListing } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { FixtureDrafter } from '@/lib/ai/drafting';
import type { MarketContext } from '@/lib/market/series';

/**
 * Deployed fix verification, Oct 2 2026: what #91 (concert-verify-1002) left open. FV-R2-03's first reply still
 * closed with "I haven't found a verified alternative…" and "Ticketmaster also lists it as on general sale…" under a
 * screenshot of Ticketmaster's own page, and its buy-or-wait follow-up kept "Those figures are StubHub and Vivid
 * Seats…" for a market section it no longer showed. FV-R1-03: the old Rangers thread got a requirement line about seats we were
 * never shown. And a resync that stores the show at 9pm with doors at 8pm turned the jigitz screenshot ("Fri, Oct 2,
 * 8:00 PM") into "doesn't fit: it starts at 9pm, not 8pm".
 */
const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
const page = { ...blank, kind: 'ticket_listing' as const, confidence: 'medium' as const, seller: 'Ticketmaster', eventName: 'jigitz', eventDate: '2026-10-02', eventTime: '20:00', venue: 'Brooklyn Paramount', city: 'Brooklyn', quantity: 2, feeBasis: 'all_in' as const, restrictions: ['Standing Room Only', 'While Supplies Last'], beforeTaxes: true, doorsTime: '20:00', showTime: '21:00' };
type Basis = 'per_ticket' | 'unknown';
/** The current screenshot (jigitz-current-two-tickets.jpg): balcony $100.17 resale, balcony $104 standard, floor $107.33 resale. */
const current = (basis: Basis) => [
  { label: 'Balcony: Standing Room Only', priceDollars: 100.17, priceBasis: basis, feeBasis: 'all_in' as const, listingType: 'resale' as const, admission: 'standing' as const },
  { label: 'Balcony: Standing Room Only', priceDollars: 104, priceBasis: basis, feeBasis: 'all_in' as const, listingType: 'primary' as const, admission: 'standing' as const },
  { label: 'GA Ticket Price Tier 2: While Supplies Last', priceDollars: 107.33, priceBasis: basis, feeBasis: 'all_in' as const, listingType: 'resale' as const, admission: 'standing' as const },
];
/** A control the package recommends: the floor is the cheapest row on the page. */
const read = (offers: ListingRead['offers']) => fieldsFromRead({ ...page, offers });

/** The live market under the jigitz replies: a venue-wide floor $81.95 before fees, 19 hours old, 52 listings. */
describe('FV-R2-03: a results page answer, then only what helps', () => {
  const at = new Date('2026-10-02T17:25:50Z');
  const market: MarketContext = { methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 8195, at: new Date('2026-10-01T22:09:00Z'), activeListings: 52 }, h24: null, h72: { hours: 72, fromCents: 6844, toCents: 8195, changeCents: 1351, pct: 0.2 }, direction: 'up', supply: { trend: 'shrinking', now: 52, before: 86, hours: 72 }, typical: null, points: 10 } as unknown as MarketContext;
  const subject = (wanted: string, basis: Basis = 'per_ticket', quoted: number | null = null): SubjectListing => ({ ...chooseShownOffer(read(current(basis)), wanted, quoted), source: 'screenshot', observedAt: at, confidence: 'high' });
  const args = (sub: SubjectListing, over: Partial<BuildPacketArgs> = {}) => ({
    requestId: 'r', revision: 1, quantity: 2, eventLabel: 'jigitz', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false },
    sourcesChecked: ['seatdata'], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    market: { basis: 'pair', context: market, supply: market.supply, supplyScope: 'all', comparableLabel: null, visible: true },
    official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/000064BDD0EBAA37' }, faceValue: null,
    subject: sub, quote: sub.perTicketCents ? { perTicketCents: sub.perTicketCents, assumedPerTicket: sub.priceBasis === 'unknown', source: 'screenshot', feeBasis: sub.feeBasis, seenAt: at, seller: 'Ticketmaster' } : null,
    seatingPreference: 'floor', timeZone: 'America/New_York', eventLocalDate: '2026-10-02', eventStartAt: new Date('2026-10-03T01:00:00Z'), eventNoun: 'show',
    ...over,
  }) as unknown as BuildPacketArgs;
  // The production path: the fixture drafter's paragraphs, then the server's renderer.
  const body = async (a: BuildPacketArgs) => {
    const packet = buildPacket(a);
    const r = validateAndRender(packet, await new FixtureDrafter().draft(packet, { quantity: 2, togetherRequired: false } as never));
    if (!r.ok) throw new Error(r.errors.join('; '));
    return r.textBody.split('\nTicket Guy\n')[0]!;
  };

  it('C02 first reply: no filler about alternatives, and over Ticketmaster’s own page only its link, not the open sale', async () => {
    const text = await body(args(subject("We'd rather be on the floor.")));
    expect(text).toContain('The floor option in your screenshot is “GA Ticket Price Tier 2: While Supplies Last”');
    expect(text).not.toMatch(/verified alternative|also lists it as on general sale|For buying directly/);
    expect(text.trim().endsWith('Event page on Ticketmaster: https://www.ticketmaster.com/event/000064BDD0EBAA37')).toBe(true);
  });

  it('C02 follow-up as production builds it: no "Those figures…" line left over from the market section it drops', async () => {
    const sub = subject("We'd rather be on the floor.\nIt's standing room — we just want two floor tickets. The screenshot says $107.33 each including fees before taxes. Would you buy those or wait until later today?", 'per_ticket', 10733);
    const text = await body(args(sub, { sourcesChecked: [], trendAsked: { noAlerts: false, riskOk: false } }));
    expect(text).toMatch(/I’d buy rather than wait/);
    expect(text).not.toMatch(/Those figures|resale market when I last checked|\$81\.95/);
  });

  it('rows from another seller’s page keep the open-sale comparison, never said as seats', async () => {
    const text = await body(args({ ...subject("We'd rather be on the floor."), seller: 'StubHub' }));
    expect(text).toContain('Ticketmaster also lists it as on general sale, but I can’t see whether it has seats left, or what they cost');
  });
});

/**
 * FV-R1-03, the old Rangers thread nudged ("should I hold off?") with the StubHub listing link it was about, no
 * resale read for the game: one statement of what we can't see, no market introduction with nothing under it, no
 * requirement line about seats we haven't been shown, and one ask.
 */
describe('FV-R1-03: a listing link with no market, asked buy or wait', () => {
  const at = new Date('2026-10-02T17:30:00Z');
  const args = {
    requestId: 'r', revision: 2, quantity: 2, eventLabel: 'New York Rangers vs. New York Islanders', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
    sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    market: null, official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/RANGERS' }, faceValue: null, subject: null, quote: null,
    link: { marketplace: 'StubHub', eventPage: false }, requirements: ['2 seats together'], trendAsked: { noAlerts: false, riskOk: false },
    seatingPreference: null, timeZone: 'America/New_York', eventLocalDate: '2026-10-06', eventStartAt: new Date('2026-10-06T23:30:00Z'), eventNoun: 'game',
  } as unknown as BuildPacketArgs;

  it('says what it can’t see once, introduces no market, and makes one ask', async () => {
    const packet = buildPacket(args);
    const r = validateAndRender(packet, await new FixtureDrafter().draft(packet, { quantity: 2, togetherRequired: true } as never));
    if (!r.ok) throw new Error(r.errors.join('; '));
    const text = r.textBody.split('\nTicket Guy\n')[0]!;
    expect(text).toContain('I couldn’t match the StubHub listing you picked in the listing data I can see, so reply with its price for two with fees and its section and row (a screenshot works)');
    expect(text).not.toMatch(/What follows is|resale market when I last checked|haven’t been able to check this against|can’t see live resale listings|most you’d pay|I can’t open StubHub/);
    expect(text.match(/screenshot/g)).toHaveLength(1);
    expect(text).toContain('Ticketmaster also sells this game directly.');
  });
});

/** The jigitz show as the catalog can hold it (9pm with doors at 8pm after a resync, 8pm before), against the page's 8:00 PM heading. */
describe('a screenshot headed with the doors time still finds the show', () => {
  let h: DbHandle;
  let n = 0;
  const NOW = new Date('2026-10-02T17:25:50Z');
  const reader: ListingReader = { name: 'fake', read: async (input) => (input.image ? { ...page, offers: current('per_ticket') } : blank) };
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  const ask = async (startAt: Date, doorsAt: Date | null) => {
    n += 1;
    const V = `40000000-0000-4000-8000-00000000f1${String(n).padStart(2, '0')}`;
    const A = `40000000-0000-4000-8000-00000000f2${String(n).padStart(2, '0')}`;
    await h.db.insert(t.venues).values({ id: V, name: `Brooklyn Paramount ${n}`, city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.6904, longitude: -73.9836 });
    await h.db.insert(t.entities).values({ id: A, kind: 'artist', name: `jigitz${n}`, slug: `jigitz-fv1002-doors-${n}`, aliases: [] });
    const [e] = await h.db.insert(t.events).values({ name: `jigitz${n}`, category: 'concert', status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster', saleStatus: 'onsale', venueId: V, primaryEntityId: A, localStartAt: startAt, doorsAt }).returning();
    await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: `JIG${n}`, authoritativeUrl: `https://www.ticketmaster.com/event/JIG${n}`, role: 'discovery', confidence: 'provider_id' });
    const c = makeConcierge(h, { now: () => NOW, listingReader: reader });
    const jpg = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } }).jpeg().toBuffer());
    const before = new Set((await h.db.select({ id: t.recommendations.id }).from(t.recommendations)).map((r) => r.id));
    const beforeSends = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((r) => r.id));
    await c.ingestInbound(inbound({ text: `jigitz${n} tonight: we don't need the floor, what's the cheapest option for two in this screenshot?`, from: `fv1002-doors-${n}@customer.example`, subject: 'jigitz tonight', receivedAt: NOW, attachments: [{ providerAttachmentId: `att-fv-doors-${n}`, filename: 'jigitz.jpg', declaredMimeType: 'image/jpeg', bytes: jpg, inline: false }] }));
    for (let j = 0; j < 8; j++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
      }
    }
    return [...(await h.db.select().from(t.recommendations)).filter((r) => !before.has(r.id)).map((r) => r.bodyText), ...(await h.db.select().from(t.sendIntents)).filter((s) => !beforeSends.has(s.id)).map((s) => s.bodyText)].join('\n');
  };

  it('stored as the 9pm show with doors at 8pm: that show, not "doesn’t fit: it starts at 9pm, not 8pm"', async () => {
    const said = await ask(new Date('2026-10-03T01:00:00Z'), new Date('2026-10-03T00:00:00Z'));
    expect(said).not.toMatch(/doesn't fit|doesn’t fit/);
    expect(said).toContain('Tonight at 9 p.m. (doors 8 p.m.) · 2 tickets');
    expect(said).toContain('The cheapest option in your screenshot is “Balcony: Standing Room Only”');
  });

  it('stored at 8pm before its doors were known: still that show', async () => {
    const said = await ask(new Date('2026-10-03T00:00:00Z'), null);
    expect(said).not.toMatch(/doesn't fit|doesn’t fit/);
    expect(said).toContain('The cheapest option in your screenshot is “Balcony: Standing Room Only”');
  });
});
