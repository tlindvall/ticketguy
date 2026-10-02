import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { subtypeFor } from '@/lib/catalog/sync';
import { chooseShownOffer, fieldsFromRead, type ListingRead, type ListingReader } from '@/lib/ai/listing-evidence';
import { buildPacket, type BuildPacketArgs, type SubjectListing } from '@/lib/advice/packet';
import { renderEvidenceOnly } from '@/lib/advice/renderer';
import type { MarketContext } from '@/lib/market/series';
import { doorsAndShow, parseDiscoveryEvent } from '@/lib/sources/adapters';

/**
 * Final human concert QA, Oct 2 2026 (deployed dadd21f, real Gmail): the exact customer texts, replayed through the
 * real intake and reply paths. Metallica: Ticketmaster's "2-Day Ticket … Cannot Split By Day" (no time of its own,
 * placed at noon by the sync) was offered as a noon show beside the 8:30pm performance. jigitz: a results-page
 * screenshot with three rows was read as one listing in "section Balcony; General Admission Floor", with no price,
 * seat-number and adjacency checks for standing room, and the floor row called face value although it says
 * Verified Resale. Rules-path extraction; the screenshot read stands in for the model's.
 */
const NOW = new Date('2026-10-02T12:19:40Z');
const SPHERE = '40000000-0000-4000-8000-00000000a002';
const BAND = '40000000-0000-4000-8000-00000000b002';
const PARAMOUNT = '40000000-0000-4000-8000-00000000a003';
const JIGITZ = '40000000-0000-4000-8000-00000000b003';

const MET = [
  'Hey, what are the best tickets for Metallica?',
  "Best value. Two seats together at the Sphere in Vegas next Thursday, October 8. I'd like a great view without spending more than $1,000 for both. What section would you pick?\n\nhttps://www.metallica.com/tour/2026-10-08-las-vegas-nevada.html",
  'The 8:30pm show. Best value rather than being right up against the stage. What would you buy for the two of us?',
];
const JIG = [
  "Hey, is this worth it for two of us tonight, or can you find cheaper? We'd rather be on the floor.\n\nhttps://www.ticketmaster.com/jigitz-brooklyn-new-york-10-02-2026/event/000064BDD0EBAA37",
  "It's standing room — we just want two floor tickets. The screenshot says $107.33 each including fees before taxes. Would you buy those or wait until later today?",
];

const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
const page = {
  ...blank,
  kind: 'ticket_listing' as const,
  confidence: 'medium' as const,
  seller: 'Ticketmaster',
  eventName: 'jigitz',
  eventDate: '2026-10-02',
  eventTime: '20:00',
  venue: 'Brooklyn Paramount',
  city: 'Brooklyn',
  quantity: 2,
  feeBasis: 'all_in' as const,
  restrictions: ['Standing Room Only', 'While Supplies Last', 'All set times and opening acts are subject to change without notice.'],
  unreadable: ['Additional results below the visible listings', "Accessible seating information is truncated after 'please email us directly...'"],
};
/** The genuine Oct 2 screenshot as the live read came back: three rows merged into one section, no price. */
class MergedReader implements ListingReader {
  readonly name = 'fake';
  async read(input: { image?: unknown }): Promise<ListingRead> {
    return input.image ? { ...page, section: 'Balcony; General Admission Floor' } : blank;
  }
}
/** The same screenshot read row by row, as the reader is now asked to (EVIDENCE: OFFER_OBSERVATION.json). */
class RowReader implements ListingReader {
  readonly name = 'fake';
  async read(input: { image?: unknown }): Promise<ListingRead> {
    if (!input.image) return blank;
    return {
      ...page,
      beforeTaxes: true,
      doorsTime: '20:00',
      showTime: '21:00',
      offers: [
        { label: 'Balcony: Standing Room Only', priceDollars: 100.17, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'resale', admission: 'standing' },
        { label: 'Balcony: Standing Room Only', priceDollars: 104, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'primary', admission: 'standing' },
        { label: 'GA Ticket Price Tier 2: While Supplies Last', priceDollars: 107.33, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'resale', admission: 'standing' },
      ],
    };
  }
}

describe('Oct 2 concert QA, replayed exactly', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; all: string[] };
  const converse = async (turns: string[], opts: { reader?: ListingReader; imageOn?: number } = {}): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW, listingReader: opts.reader });
    n += 1;
    const jpg = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } }).jpeg().toBuffer());
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const [i, text] of turns.entries()) {
      const attachments = opts.imageOn === i ? [{ providerAttachmentId: `att-${n}`, filename: 'jigitz-current-two-tickets.jpg', declaredMimeType: 'image/jpeg', bytes: jpg, inline: false }] : [];
      const at = new Date(NOW.getTime() + i * 120_000);
      const m = inbound({ text, from: `qa1002-${n}@customer.example`, subject: prev ? 'Re: Tickets' : 'Tickets', receivedAt: at, inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null, attachments });
      const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
      const beforeRecs = new Set((await h.db.select({ id: t.recommendations.id }).from(t.recommendations)).map((r) => r.id));
      await c.ingestInbound(m);
      prev = m;
      for (let j = 0; j < 8; j++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(at.getTime() + 10_000) });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, at);
        }
      }
      const sends = (await h.db.select().from(t.sendIntents)).filter((s) => !before.has(s.id)).map((s) => s.bodyText);
      const recs = (await h.db.select().from(t.recommendations)).filter((r) => !beforeRecs.has(r.id)).map((r) => r.bodyText);
      const said = [...sends, ...recs];
      out.push({ text: (recs.at(-1) ?? sends.at(-1) ?? '').split('\nTicket Guy\n')[0]!, all: said });
    }
    return out;
  };

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values([
      { id: SPHERE, name: 'Sphere', city: 'Las Vegas', state: 'NV', country: 'US', timezone: 'America/Los_Angeles', latitude: 36.1208, longitude: -115.1619 },
      { id: PARAMOUNT, name: 'Brooklyn Paramount', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.6904, longitude: -73.9836 },
    ]);
    await h.db.insert(t.entities).values([
      { id: BAND, kind: 'artist', name: 'Metallica', slug: 'metallica-1002', aliases: [] },
      { id: JIGITZ, kind: 'artist', name: 'jigitz', slug: 'jigitz-1002', aliases: [] },
    ]);
    const ev = async (row: Omit<typeof t.events.$inferInsert, 'category'>, key: string) => {
      const [e] = await h.db.insert(t.events).values({ category: 'concert', status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster', saleStatus: 'onsale', ...row }).returning();
      await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: key, authoritativeUrl: `https://www.ticketmaster.com/event/${key}`, role: 'discovery', confidence: 'provider_id' });
      return e!;
    };
    // As the sync stored them before this change: the pass has no time of its own and was placed at noon local,
    // tagged time_tba; the suite is already a package.
    await ev({ name: 'Metallica: Life Burns Faster', genre: 'rock / hard rock', venueId: SPHERE, primaryEntityId: BAND, localStartAt: new Date('2026-10-09T03:30:00Z') }, '1700645AB15DD4DB');
    await ev({ name: 'Metallica 2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day', genre: 'rock / hard rock', venueId: SPHERE, primaryEntityId: BAND, localStartAt: new Date('2026-10-08T19:00:00Z'), subtype: 'time_tba' }, 'MET2DAY0810');
    await ev({ name: 'Metallica - Suite Reservation', genre: 'rock / hard rock', venueId: SPHERE, primaryEntityId: BAND, localStartAt: new Date('2026-10-09T03:30:00Z'), subtype: 'package' }, 'METSUITE0810');
    await ev({ name: 'jigitz', genre: 'dance/electronic / house', venueId: PARAMOUNT, primaryEntityId: JIGITZ, localStartAt: new Date('2026-10-03T00:00:00Z') }, '000064BDD0EBAA37');
  });
  afterAll(async () => {
    await h.close();
  });

  it('HF-C-01: a multi-day pass that cannot be split is a package, not a performance', () => {
    expect(subtypeFor({ name: 'Metallica 2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day', timeTba: true })).toBe('package');
    expect(subtypeFor({ name: 'Metallica 2-Day Ticket (10/1/26 & 10/3/26)', timeTba: true })).toBe('package');
    // A single performance, and a festival's own day or weekend pass, are still admissions.
    expect(subtypeFor({ name: 'Metallica: Life Burns Faster', timeTba: false })).toBeNull();
    expect(subtypeFor({ name: 'Governors Ball - Saturday 1-Day Ticket', timeTba: false })).toBeNull();
    expect(subtypeFor({ name: 'Governors Ball 3-Day Pass', timeTba: false })).toBeNull();
    expect(subtypeFor({ name: 'Weekend Pass - Lollapalooza', timeTba: false })).toBeNull();
  });

  it('HF-C-01: the exact Metallica thread never offers a noon show, and keeps two together and $1,000', async () => {
    const [t1, t2, t3] = await converse(MET);
    expect(t1!.text).toContain('Are you after the best view, the best value, or the lowest price?');
    const second = t2!.all.join('\n');
    expect(second).not.toMatch(/12pm|12:00 ?PM|Which show|2-Day|Cannot Split/i);
    // "$1,000 for both" is a thousand dollars for the pair, not $1 (the rules reader read the comma as a decimal point).
    expect(second).toContain('Sphere, Las Vegas · Thu, Oct 8, 8:30 PM PDT · 2 tickets · up to $1,000 in total');
    expect(second).not.toMatch(/\$1 total|read \$1 as/);
    expect(t3!.text).toContain('Metallica: Life Burns Faster\nSphere, Las Vegas · Thu, Oct 8, 8:30 PM PDT · 2 tickets · up to $1,000 in total');
  });

  it('HF-C-02/03/07: the exact jigitz thread, read row by row, opens with the floor row and two’s total', async () => {
    const [j1, j2] = await converse(JIG, { reader: new RowReader(), imageOn: 0 });
    expect(j1!.text).toContain('jigitz\nBrooklyn Paramount, Brooklyn · Tonight, Fri, Oct 2, 9:00 PM EDT (doors 8:00 PM) · 2 tickets\n\nThe floor option in your screenshot is “GA Ticket Price Tier 2: While Supplies Last”, a resale ticket, at $107.33 a ticket including fees, before taxes: $214.66 for two.');
    expect(j1!.text).toContain('It also shows Balcony: Standing Room Only at $100.17 a ticket (resale) and $104 a ticket (Ticketmaster’s own ticket).');
    for (const t of [j1!.text, j2!.text]) expect(t).not.toMatch(/seat numbers|seats are together|Balcony; General Admission Floor|Accessible seating information|Additional results|face value, not a resale markup|\.\./);
    expect(j2!.text).toContain('2 tickets\n\nIf $214.66 for two (with fees and before taxes) works for you and the floor is what you want, I’d buy rather than wait.');
    expect(j2!.text).toContain('It’s tonight, so waiting also risks the tickets you found going. If the balcony would do, “Balcony: Standing Room Only” at $100.17 a ticket on the same page is $14.32 less for two.');
  });

  it('HF-C-02/03: a read that ran the rows together keeps the floor part, and the typed price fills it in', async () => {
    const [m1, m2] = await converse(JIG, { reader: new MergedReader(), imageOn: 0 });
    expect(m1!.text).toContain('in section General Admission Floor, on Ticketmaster');
    for (const t of [m1!.text, m2!.text]) expect(t).not.toMatch(/seat numbers|seats are together|Balcony; General Admission Floor|Accessible seating information|\.\./);
    expect(m2!.text).toContain('The screenshot you sent shows $107.33 a ticket including fees on Ticketmaster.');
    expect(m2!.text).not.toMatch(/taken that as per ticket|price per ticket, or for all/);
    expect(m2!.text).toContain('If $214.66 for two (with fees and before taxes) works for you, I’d buy rather than wait.');
  });
});

/**
 * The jigitz turns with the market the live replies had (StubHub/Vivid floor $81.95 before fees, 14 hours old, 52
 * listings, not enough history for the group), built straight from the packet so the market is the live one.
 */
describe('jigitz with the live market: the row, the party total, then the context', () => {
  const at = new Date('2026-10-02T12:21:58Z');
  const market: MarketContext = { methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'insufficient', reasons: ['too_few_points'], current: { priceCents: 8195, at: new Date('2026-10-01T22:09:00Z'), activeListings: 52 }, h24: null, h72: { hours: 72, fromCents: 6844, toCents: 8195, changeCents: 1351, pct: 0.2 }, direction: 'up', supply: { trend: 'shrinking', now: 52, before: 86, hours: 72 }, typical: null, points: 3 } as unknown as MarketContext;
  const rows = (await_: ListingRead) => fieldsFromRead(await_);
  const subject = (wanted: string, quoted: number | null = null): SubjectListing => ({ ...chooseShownOffer(rows({ ...page, beforeTaxes: true, doorsTime: '20:00', showTime: '21:00', offers: [
    { label: 'Balcony: Standing Room Only', priceDollars: 100.17, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'resale', admission: 'standing' },
    { label: 'Balcony: Standing Room Only', priceDollars: 104, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'primary', admission: 'standing' },
    { label: 'GA Ticket Price Tier 2: While Supplies Last', priceDollars: 107.33, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType: 'resale', admission: 'standing' },
  ] }), wanted, quoted), source: 'screenshot', observedAt: at, confidence: 'high' });
  const args = (sub: SubjectListing, over: Partial<BuildPacketArgs> = {}) => ({
    requestId: 'r', revision: 1, quantity: 2, eventLabel: 'jigitz', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false },
    sourcesChecked: ['seatdata'], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    market: { basis: 'pair', context: market, supply: market.supply, supplyScope: 'all', comparableLabel: null, visible: true },
    official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/000064BDD0EBAA37' }, faceValue: null,
    subject: sub, quote: sub.perTicketCents ? { perTicketCents: sub.perTicketCents, assumedPerTicket: false, source: 'screenshot', feeBasis: sub.feeBasis, seenAt: at, seller: 'Ticketmaster' } : null,
    seatingPreference: 'floor', timeZone: 'America/New_York', eventLocalDate: '2026-10-02', eventStartAt: new Date('2026-10-03T01:00:00Z'), eventNoun: 'show',
    ...over,
  }) as unknown as BuildPacketArgs;
  const body = (a: BuildPacketArgs) => renderEvidenceOnly(buildPacket(a)).textBody.split('\nTicket Guy\n')[0]!;

  it('HF-C-02: the floor row is chosen from three, and the reply opens with it and what two cost', () => {
    const sub = subject("Hey, is this worth it for two of us tonight, or can you find cheaper? We'd rather be on the floor.");
    expect(sub).toMatchObject({ section: 'GA Ticket Price Tier 2: While Supplies Last', perTicketCents: 10733, wholePartyCents: 21466, listingType: 'resale', admission: 'standing', chosenFor: 'floor', feeBasis: 'all_in', beforeTaxes: true });
    const text = body(args(sub));
    expect(text).toContain('The floor option in your screenshot is “GA Ticket Price Tier 2: While Supplies Last”, a resale ticket, at $107.33 a ticket including fees, before taxes: $214.66 for two. It’s $25.38 a ticket above the cheapest listing I can see ($81.95 before fees).');
    expect(text).toContain('It also shows Balcony: Standing Room Only at $100.17 a ticket (resale) and $104 a ticket (Ticketmaster’s own ticket).');
    expect(text).not.toMatch(/Balcony; General Admission Floor|in section Balcony/);
    // The floor-gap line follows the row; it never opens a same-day reply on its own.
    expect(text.indexOf('The floor option')).toBeLessThan(text.indexOf('$25.38'));
  });

  it('"a lower price" or "box office" is not an area: the cheapest row, said as such', () => {
    const sub = subject('Can you find a lower price? I could also buy at the box office.');
    expect(sub).toMatchObject({ perTicketCents: 10017, chosenFor: null });
    expect(body(args(sub, { seatingPreference: null }))).toContain('The cheapest option in your screenshot is “Balcony: Standing Room Only”, a resale ticket, at $100.17 a ticket including fees, before taxes: $200.34 for two.');
  });

  it('HF-C-03: standing room has no seat-number, together or cut-off accessibility checks', () => {
    const text = body(args(subject('floor')));
    expect(text).not.toMatch(/seat numbers|seats are together|Accessible seating information|Additional results|\.\./);
    expect(text).toContain('The screenshot doesn’t show when the tickets will be delivered.');
  });

  it('HF-C-04: a resale row is never face value; the standard row is the seller’s own ticket', () => {
    const resale = buildPacket(args(subject('floor'))).claimRecords.find((c) => c.id === 'C_QUOTE');
    expect(resale!.text).toBe('It’s marked as resale, so $107.33 is a resale price, not face value, and Ticketmaster doesn’t publish a face-value range for this show to set it against.');
    const standard = buildPacket(args(subject('balcony', 10400))).claimRecords.find((c) => c.id === 'C_QUOTE');
    expect(standard!.text).toBe('It’s Ticketmaster’s own ticket, not resale, so there’s no resale markup in it; with fees included it’s more than the face value, which isn’t published for this show.');
    const text = body(args(subject('floor')));
    expect(text).not.toMatch(/face value, not a resale markup/);
  });

  it('HF-C-06: "buy those or wait until later today?" gets a decision with the party total, then why', () => {
    const sub = subject("It's standing room — we just want two floor tickets. The screenshot says $107.33 each including fees before taxes. Would you buy those or wait until later today?", 10733);
    expect(sub.chosenFor).toBe('floor');
    const text = body(args(sub, { trendAsked: { noAlerts: false, riskOk: false } }));
    expect(text.split('\n\n')[2]).toBe('If $214.66 for two (with fees and before taxes) works for you and the floor is what you want, I’d buy rather than wait. I don’t have a supported price trend for two floor tickets at this show, so I can’t tell you whether prices are rising or falling, and waiting would be a guess. I haven’t collected a comparable price history for it yet. It’s tonight, so waiting also risks the tickets you found going. If the balcony would do, “Balcony: Standing Room Only” at $100.17 a ticket on the same page is $14.32 less for two.');
    // Over their cap, the view says so instead.
    const capped = body(args(sub, { trendAsked: { noAlerts: false, riskOk: false }, priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: 20000, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false } }));
    expect(capped).toContain('At $214.66 for two it’s over your $200, so I wouldn’t buy these as they are.');
    expect(capped).not.toContain('I’d buy rather than wait');
  });

  it('HF-C-05: an open sale is never said as seats being there', () => {
    const official = buildPacket(args(subject('floor'))).claimRecords.find((c) => c.id === 'C_OFFICIAL');
    expect(official!.text).toBe('Ticketmaster also lists it as on general sale, but I can’t see whether it has seats left, or what they cost, so check the all-in total and the seats there before you buy.');
  });

  it('reserved-seat control: a single seated listing keeps its together and seat-number checks', () => {
    const seated: SubjectListing = { ...fieldsFromRead({ ...blank, kind: 'ticket_listing', confidence: 'high', seller: 'StubHub', quantity: 2, priceDollars: 120, priceBasis: 'per_ticket', feeBasis: 'all_in', section: '212', row: 'D' }), source: 'screenshot', observedAt: at, confidence: 'high' };
    const text = body(args(seated, { seatingPreference: null }));
    expect(text).toContain('The screenshot doesn’t show whether the seats are together.');
    expect(text).toContain('The screenshot doesn’t show seat numbers.');
  });
});

describe('HF-C-07: doors and show', () => {
  it('reads "Doors: 8PM Show: 9PM" and nothing less', () => {
    expect(doorsAndShow('Doors: 8PM Show: 9PM All set times and opening acts are subject to change without notice.')).toEqual({ doors: '20:00', show: '21:00' });
    expect(doorsAndShow('Doors open at 7:30 pm, show at 8:30 pm')).toEqual({ doors: '19:30', show: '20:30' });
    expect(doorsAndShow('Doors: 8PM')).toBeNull();
    expect(doorsAndShow(null)).toBeNull();
  });
  it('a provider start that is the doors time becomes the show, with doors kept', () => {
    const e = (pleaseNote: string | null, localTime = '20:00:00') => parseDiscoveryEvent({
      id: '000064BDD0EBAA37', name: 'jigitz', url: 'https://www.ticketmaster.com/event/000064BDD0EBAA37', pleaseNote,
      dates: { start: { localDate: '2026-10-02', localTime, dateTime: `2026-10-03T00:00:00Z`, timeTBA: false, noSpecificTime: false }, timezone: 'America/New_York', status: { code: 'onsale' } },
      _embedded: { venues: [{ id: 'v', name: 'Brooklyn Paramount', city: { name: 'Brooklyn' }, state: { stateCode: 'NY' }, country: { countryCode: 'US' }, timezone: 'America/New_York' }] },
    })!;
    expect(e('Doors: 8PM Show: 9PM All set times and opening acts are subject to change without notice.')).toMatchObject({ startAt: '2026-10-03T01:00:00.000Z', localTime: '21:00:00', doorsAt: '2026-10-03T00:00:00.000Z' });
    // No notes, or a start that isn't the doors time: left as the provider gave it.
    expect(e(null)).toMatchObject({ startAt: '2026-10-03T00:00:00Z', localTime: '20:00:00', doorsAt: null });
    expect(e('Doors: 7PM Show: 8PM')).toMatchObject({ startAt: '2026-10-03T00:00:00Z', doorsAt: null });
  });
});
