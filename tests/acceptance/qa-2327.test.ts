import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';

/**
 * Post-deploy QA, Oct 2 23:27 (pinned 3a4b695, capture-only, production extraction): the exact Research2 follow-ups.
 * S02 turn 2: "We have $220 for both, including fees but before tax. Does the $107.33 each option fit?" saved no
 * budget (the cap was taken for the listing's price and dropped) and never said whether it fits. S03 turn 2: "Tier 3
 * says $113.29 each and Tier 2 says $118.06 each. Which is cheaper for two, and does that include the tax?" got the
 * opening summary and a balcony comparison again. Rows as the evidence images record them.
 */
type Row = NonNullable<ListingRead['offers']>[number];
const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
const row = (label: string, price: number, listingType: Row['listingType']): Row => ({ label, priceDollars: price, priceBasis: 'per_ticket', feeBasis: 'all_in', listingType, admission: 'standing' });
const MORNING = [row('Balcony: Standing Room Only', 100.17, 'resale'), row('Balcony: Standing Room Only', 104, 'primary'), row('GA Ticket Price Tier 2: While Supplies Last', 107.33, 'resale')];
const AFTERNOON = [row('Balcony: Standing Room Only', 104, 'primary'), row('GA Ticket Price Tier 3: While Supplies Last', 113.29, 'resale'), row('GA Ticket Price Tier 2: While Supplies Last', 118.06, 'resale')];
const page = (offers: Row[]): ListingRead => ({ ...blank, kind: 'ticket_listing', confidence: 'high', seller: 'Ticketmaster', eventName: 'jigitz', eventDate: '2026-10-02', eventTime: '20:00', venue: 'Brooklyn Paramount', city: 'Brooklyn', quantity: 2, feeBasis: 'all_in', beforeTaxes: true, doorsTime: '20:00', showTime: '21:00', offers, restrictions: ['Standing Room Only'] });
class Reader implements ListingReader {
  readonly name = 'fake';
  constructor(private readonly offers: Row[]) {}
  async read(input: { image?: unknown }): Promise<ListingRead> {
    return input.image ? page(this.offers) : blank;
  }
}
const LINK = 'https://www.ticketmaster.com/jigitz-brooklyn-new-york-10-02-2026/event/000064BDD0EBAA37';
const S02 = [`We don't need the floor — what's the cheapest option for two in this screenshot?\n\n${LINK}`, "Actually, we'd rather be on the floor — not the balcony. We have $220 for both, including fees but before tax. Does the $107.33 each option fit?"];
const S03 = [`This is the screenshot I took earlier. Two of us would rather be on the floor. Which row would you pick, and what would we pay for both before tax?\n\n${LINK}`, "It's the same jigitz event in the link — Brooklyn Paramount tonight. Tier 3 says $113.29 each and Tier 2 says $118.06 each. Which is cheaper for two, and does that include the tax?"];
const NOW = new Date('2026-10-02T23:30:00Z');

describe('post-deploy QA 23:27, screenshot follow-ups replayed', () => {
  let h: DbHandle;
  let n = 0;
  const converse = async (turns: string[], offers: Row[]) => {
    const c = makeConcierge(h, { now: () => NOW, listingReader: new Reader(offers) });
    n += 1;
    const jpg = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } }).jpeg().toBuffer());
    let prev: ReturnType<typeof inbound> | null = null;
    let requestId = '';
    const out: string[] = [];
    for (const [i, text] of turns.entries()) {
      const at = new Date(NOW.getTime() + i * 60_000);
      const m = inbound({ text, from: `qa2327-${n}@customer.example`, subject: prev ? 'Re: jigitz' : 'jigitz', receivedAt: at, inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null, attachments: i === 0 ? [{ providerAttachmentId: `att-2327-${n}`, filename: 'jigitz.jpg', declaredMimeType: 'image/jpeg', bytes: jpg, inline: false }] : [] });
      const beforeRecs = new Set((await h.db.select({ id: t.recommendations.id }).from(t.recommendations)).map((r) => r.id));
      const r = (await c.ingestInbound(m)) as { requestId: string };
      requestId = r.requestId;
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
      const recs = (await h.db.select().from(t.recommendations)).filter((x) => !beforeRecs.has(x.id));
      out.push((recs.at(-1)?.bodyText ?? '').split('\nTicket Guy\n')[0]!);
    }
    const versions = (await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId))).sort((x, y) => y.revision - x.revision);
    return { out, brief: versions[0]!.brief as { budgetCents: number | null; budgetBasis: string | null; quantity: number } };
  };

  beforeAll(async () => {
    h = await openTestDb();
    const [v] = await h.db.insert(t.venues).values({ name: 'Brooklyn Paramount', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.6904, longitude: -73.9836 }).returning();
    const [a] = await h.db.insert(t.entities).values({ kind: 'artist', name: 'jigitz', slug: 'jigitz-2327', aliases: [] }).returning();
    const [e] = await h.db.insert(t.events).values({ name: 'jigitz', genre: 'dance/electronic / house', category: 'concert', venueId: v!.id, primaryEntityId: a!.id, localStartAt: new Date('2026-10-03T00:00:00Z'), status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster', saleStatus: 'onsale' }).returning();
    await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: '000064BDD0EBAA37', authoritativeUrl: LINK, role: 'discovery', confidence: 'provider_id' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('S02: "$220 for both" is saved as the cap, and the reply opens by saying the floor pair fits it', async () => {
    const { out, brief } = await converse(S02, MORNING);
    expect(out[0]).toContain('The cheapest option in your screenshot is “Balcony: Standing Room Only”');
    expect(brief).toMatchObject({ budgetCents: 22000, budgetBasis: 'whole_party', quantity: 2 });
    expect(out[1]).toContain('2 tickets · up to $220 in total\n\nYes: $214.66 for two is within your $220, with $5.34 to spare.');
    // "Not the balcony": the balcony is no longer offered as the trade-off.
    expect(out[1]).not.toMatch(/cheapest balcony option/);
  });

  it('S03: which floor tier is cheaper for two, by how much, and that tax is extra, first', async () => {
    const { out } = await converse(S03, AFTERNOON);
    expect(out[0]).toContain('The floor option in your screenshot is “GA Ticket Price Tier 3: While Supplies Last”');
    expect(out[1]).toContain('2 tickets\n\nGA Ticket Price Tier 3 is cheaper: $226.58 for two, against $236.12 for GA Ticket Price Tier 2, so $9.54 less. Those prices include fees but not tax, so tax is added on top at checkout.');
    // The opening summary and its balcony comparison aren't repeated.
    expect(out[1]).not.toMatch(/The floor option in your screenshot|\$18\.58|isn’t face value/);
  });

  it('S04: which Metallica product is the Oct 8 concert ticket, and the 2-Day Ticket can’t be counted on to split', async () => {
    const [sphere] = await h.db.insert(t.venues).values({ name: 'Sphere', city: 'Las Vegas', state: 'NV', country: 'US', timezone: 'America/Los_Angeles', latitude: 36.1208, longitude: -115.1619 }).returning();
    const [band] = await h.db.insert(t.entities).values({ kind: 'artist', name: 'Metallica', slug: 'metallica-2327', aliases: [] }).returning();
    const ev = async (name: string, at: string, subtype: string | null, key: string) => {
      const [e] = await h.db.insert(t.events).values({ name, genre: 'rock / hard rock', category: 'concert', venueId: sphere!.id, primaryEntityId: band!.id, localStartAt: new Date(at), subtype, status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster', saleStatus: 'onsale' }).returning();
      await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: key, authoritativeUrl: `https://www.ticketmaster.com/event/${key}`, role: 'discovery', confidence: 'provider_id' });
    };
    await ev('Metallica: Life Burns Faster', '2026-10-09T03:30:00Z', null, '1700645AB15DD4DB');
    await ev('Metallica - Suite Reservation', '2026-10-09T03:30:00Z', 'package', 'METSUITE2327');
    await ev('Metallica 2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day', '2026-10-08T19:00:00Z', 'package', 'MET2DAY2327');
    const S04 = [
      "I want two tickets to Metallica at Sphere on October 8 only. In this screenshot I see Life Burns Faster, Suite Reservation and a 2-Day Ticket. Which should I start with? I don't want a hotel or VIP add-on.\n\nhttps://www.ticketmaster.com/metallica-tickets/artist/735647",
      "Could I buy the 2-Day Ticket and split it with a friend — I'd go October 8 and they'd go October 10? Does this screenshot prove two single-night tickets are available?",
    ];
    // The product page read as a listing with nothing priced on it, as the live read came back (fields null).
    const c = makeConcierge(h, { now: () => NOW, listingReader: { name: 'fake', read: async (i: { image?: unknown }) => (i.image ? { ...blank, kind: 'ticket_listing' as const, confidence: 'high' as const } : blank) } });
    const jpg = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } }).jpeg().toBuffer());
    let prev: ReturnType<typeof inbound> | null = null;
    const out: string[] = [];
    for (const [i, text] of S04.entries()) {
      const at = new Date(NOW.getTime() + i * 60_000);
      const m = inbound({ text, from: 'qa2327-s04@customer.example', subject: prev ? 'Re: Metallica' : 'Metallica', receivedAt: at, inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null, attachments: i === 0 ? [{ providerAttachmentId: 'att-s04', filename: 'metallica-products.jpg', declaredMimeType: 'image/jpeg', bytes: jpg, inline: false }] : [] });
      const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((x) => x.id));
      await c.ingestInbound(m);
      prev = m;
      for (let j = 0; j < 8; j++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(at.getTime() + 10_000) });
        if (!leased.length) break;
        for (const e of leased) {
          const p = e.payload as Record<string, string>;
          if (e.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          if (e.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
          await markDispatched(h.db, e.id, e.leaseToken, at);
        }
      }
      out.push((await h.db.select().from(t.sendIntents)).filter((x) => !before.has(x.id)).map((x) => x.bodyText).join('\n=====\n'));
    }
    expect(out[0]).toContain('Start with Metallica: Life Burns Faster on Thu, Oct 8 at 8:30pm: that’s the concert ticket for that night on its own.');
    expect(out[0]).toContain('“Metallica - Suite Reservation” is a suite booking.');
    expect(out[0]).toContain('“Metallica 2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day” is one ticket for more than one night, and it says it can’t be split by day');
    expect(out[0]).not.toMatch(/What’s the most you’d pay|Buy on Ticketmaster|that’s where I’d buy/);
    expect(out[1]).toContain('I wouldn’t plan on splitting it: Ticketmaster lists it as “Metallica 2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day”, so it’s sold as one ticket for both nights, not as two single-night tickets.');
    expect(out[1]).toContain('And no, the screenshot doesn’t show that two single-night tickets are available: it shows what’s on sale, not whether any seats are left.');
    expect(out[1]).toContain('Event page on Ticketmaster:');
  });
});
