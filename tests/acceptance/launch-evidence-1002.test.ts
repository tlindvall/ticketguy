import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { eq } from 'drizzle-orm';

/**
 * Final launch review, Oct 2 2026 (Workstream A): the exact customer texts and the original screenshots, replayed
 * through the real intake and reply path. The reads stand in for the production reader and hold only what each image
 * shows (tests/fixtures/launch-images, sha256 in the package's IMAGE_PROVENANCE.json). Before this change:
 *  - S01/B01: the jigitz show had started, so the catalog matched nothing and they got "I couldn't find a jigitz
 *    performance" under a screenshot that answers the question;
 *  - P02/S03: an unpriced product page or sold-out page was dropped as evidence and the reply was the official-sale
 *    template;
 *  - S02: the first image's event was applied to the whole request, blending jigitz into Metallica at Sphere.
 */
const IMG = (f: string) => new Uint8Array(readFileSync(join(__dirname, '../fixtures/launch-images', f)));
const TM = 'https://www.ticketmaster.com/jigitz-brooklyn-new-york-10-02-2026/event/000064BDD0EBAA37';
// Fri Oct 2, 10:30pm in Brooklyn: the jigitz show (8pm doors, 9pm show) is under way; Metallica is next week.
const NOW = new Date('2026-10-03T02:30:00Z');
const SPHERE = '40000000-0000-4000-8000-00000000c102';
const PARAMOUNT = '40000000-0000-4000-8000-00000000c103';
const BAND = '40000000-0000-4000-8000-00000000d102';
const JIG = '40000000-0000-4000-8000-00000000d103';

const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
const jigitzPage = { ...blank, kind: 'ticket_listing' as const, confidence: 'high' as const, seller: 'Ticketmaster', eventName: 'jigitz', eventDate: '2026-10-02', eventTime: '20:00', venue: 'Brooklyn Paramount', city: 'Brooklyn', quantity: 2, feeBasis: 'all_in' as const, beforeTaxes: true, doorsTime: '20:00', showTime: '21:00', restrictions: ['All set times and opening acts are subject to change without notice.'] };
const row = (label: string, priceDollars: number, listingType: 'resale' | 'primary') => ({ label, priceDollars, priceBasis: 'per_ticket' as const, feeBasis: 'all_in' as const, listingType, admission: 'standing' as const });
/** jigitz-morning.jpg: 7 results, balcony $100.17 resale, balcony $104 standard, floor Tier 2 $107.33 resale. */
const MORNING: ListingRead = { ...jigitzPage, offers: [row('Balcony: Standing Room Only', 100.17, 'resale'), row('Balcony: Standing Room Only', 104, 'primary'), row('GA Ticket Price Tier 2: While Supplies Last', 107.33, 'resale')] };
/** jigitz-afternoon.jpg: 8 results, balcony $104 standard, floor Tier 3 $113.29 resale, floor Tier 2 $118.06 resale. */
const AFTERNOON: ListingRead = { ...jigitzPage, offers: [row('Balcony: Standing Room Only', 104, 'primary'), row('GA Ticket Price Tier 3: While Supplies Last', 113.29, 'resale'), row('GA Ticket Price Tier 2: While Supplies Last', 118.06, 'resale')] };
const product = (label: string, kind: 'single_show' | 'multi_day' | 'suite', date: string, over: Record<string, unknown> = {}) => ({ label, kind, date, endDate: null, time: null, venue: 'Sphere', city: 'Las Vegas', terms: [], promoted: false, ...over });
/** metallica-products.jpg: the artist page's rows, with a promoted row for another show. No prices, no sale status. */
const PRODUCTS: ListingRead = {
  ...blank, kind: 'event_page', confidence: 'high', seller: 'Ticketmaster', eventName: 'Metallica', venue: 'Sphere', city: 'Las Vegas',
  events: [{ name: 'R&B Tour: Usher & Chris Brown', performer: 'Usher', date: '2026-10-15', time: null, venue: 'MetLife Stadium', city: 'East Rutherford', promoted: true }],
  products: [
    product('Metallica: Life Burns Faster', 'single_show', '2026-10-03', { time: '20:30' }),
    product('Metallica - Suite Reservation', 'suite', '2026-10-08', { terms: ['On partner site'] }),
    product('Metallica: Life Burns Faster', 'single_show', '2026-10-08', { time: '20:30' }),
    product('Metallica 2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day', 'multi_day', '2026-10-08', { endDate: '2026-10-10', terms: ['Cannot Split By Day'] }),
  ],
};
/** metallica-single-night-sold-out.jpg: the Oct 8 page, sold out, with a hotel-package banner. */
const SOLD_OUT: ListingRead = {
  ...blank, kind: 'event_page', confidence: 'high', seller: 'Ticketmaster', eventName: 'Metallica: Life Burns Faster', eventDate: '2026-10-08', eventTime: '20:30', venue: 'Sphere', city: 'Las Vegas', feeBasis: 'all_in', beforeTaxes: true,
  availability: { status: 'sold_out', text: 'Tickets are sold out now. Check back soon.' },
  notices: ['Concert & Hotel Packages On Sale Now: premium concert tickets, a 3-night hotel stay and more from Vibee'],
};

/** The production reader, stood in for: each screenshot read in the order attached, the email text read as nothing. */
class QueueReader implements ListingReader {
  readonly name = 'fake';
  queue: ListingRead[] = [];
  questions: Array<string | null | undefined> = [];
  async read(input: { image?: unknown; question?: string | null }): Promise<ListingRead> {
    if (!input.image) return blank;
    this.questions.push(input.question);
    return this.queue.shift() ?? blank;
  }
}

type Turn = { text: string; reads: ListingRead[]; images?: string[] };
type Reply = { text: string; subject: string; html: string };

describe('Final launch review, Workstream A, replayed with the original screenshots', () => {
  let h: DbHandle;
  let n = 0;
  const reader = new QueueReader();
  const converse = async (turns: Turn[]): Promise<Reply[]> => {
    const c = makeConcierge(h, { now: () => NOW, listingReader: reader });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Reply[] = [];
    for (const [i, turn] of turns.entries()) {
      reader.queue = [...turn.reads];
      const at = new Date(NOW.getTime() + i * 120_000);
      const attachments = (turn.images ?? []).map((f, k) => ({ providerAttachmentId: `launch-${n}-${i}-${k}`, filename: f, declaredMimeType: 'image/jpeg', bytes: IMG(f), inline: false }));
      const m = inbound({ text: turn.text, from: `launch-a-${n}@customer.example`, subject: prev ? 'Re: Tickets' : 'Tickets', receivedAt: at, inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null, attachments });
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
      const sends = (await h.db.select().from(t.sendIntents)).filter((s) => !before.has(s.id));
      const recs = (await h.db.select().from(t.recommendations)).filter((r) => !beforeRecs.has(r.id));
      const last = recs.at(-1) ?? sends.at(-1);
      out.push({ text: (last?.bodyText ?? '').split('\nTicket Guy\n')[0]!, subject: sends.at(-1)?.subject ?? '', html: (last as { bodyHtml?: string } | undefined)?.bodyHtml ?? '' });
      // E: a single decision stays within 220 words.
      expect(out.at(-1)!.text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(220);
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
      { id: BAND, kind: 'artist', name: 'Metallica', slug: 'metallica-launch-1002', aliases: [] },
      { id: JIG, kind: 'artist', name: 'jigitz', slug: 'jigitz-launch-1002', aliases: [] },
    ]);
    const ev = async (row: Omit<typeof t.events.$inferInsert, 'category'>, key: string) => {
      const [e] = await h.db.insert(t.events).values({ category: 'concert', status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster', saleStatus: 'onsale', ...row }).returning();
      await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: key, authoritativeUrl: `https://www.ticketmaster.com/event/${key}`, role: 'discovery', confidence: 'provider_id' });
      return e!;
    };
    await ev({ name: 'Metallica: Life Burns Faster', genre: 'rock / hard rock', venueId: SPHERE, primaryEntityId: BAND, localStartAt: new Date('2026-10-09T03:30:00Z') }, 'LAUNCHMET0810');
    await ev({ name: 'Metallica 2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day', genre: 'rock / hard rock', venueId: SPHERE, primaryEntityId: BAND, localStartAt: new Date('2026-10-08T19:00:00Z'), subtype: 'package' }, 'LAUNCHMET2DAY');
    await ev({ name: 'Metallica - Suite Reservation', genre: 'rock / hard rock', venueId: SPHERE, primaryEntityId: BAND, localStartAt: new Date('2026-10-09T03:30:00Z'), subtype: 'package' }, 'LAUNCHMETSUITE');
    await ev({ name: 'jigitz', genre: 'dance/electronic / house', venueId: PARAMOUNT, primaryEntityId: JIG, localStartAt: new Date('2026-10-03T01:00:00Z'), doorsAt: new Date('2026-10-03T00:00:00Z') }, '000064BDD0EBAA37');
  });
  afterAll(async () => {
    await h.close();
  });

  it('S01 (A09): doors and show and standing room, from the screenshot, after the show has started', async () => {
    const [r] = await converse([{ text: `I grabbed this screenshot earlier. Is 8pm the actual show or the doors? And are the floor tickets seats or standing?\n\n${TM}`, images: ['jigitz-afternoon.jpg'], reads: [AFTERNOON] }]);
    expect(r!.text).toContain('Doors open at 8pm and the show starts at 9pm, going by the page in your screenshot.');
    expect(r!.text).toContain('The floor tickets are standing room: general admission, with no assigned seats.');
    expect(r!.text).toContain('That show has already started, so I can’t check what’s left now');
    expect(r!.text).not.toMatch(/couldn’t find|couldn't find|which event|Which show/i);
    // The reader is told what they asked, to focus the read (A04).
    expect(reader.questions.at(-1)).toContain('Is 8pm the actual show or the doors?');
  });

  it('B01 (A01/A04): cheapest, then the $220 cap against $107.33 each, then the later screenshot’s two floor rows', async () => {
    const [b1, b2, b3] = await converse([
      { text: `We don't need the floor — what's the cheapest option for two in this screenshot?\n\n${TM}`, images: ['jigitz-morning.jpg'], reads: [MORNING] },
      { text: "Actually, we'd rather be on the floor — not the balcony. We have $220 for both, including fees but before tax. Does the $107.33 each option fit?", reads: [] },
      { text: 'This is the later screenshot. Same budget, still floor only. Can we afford either of these floor options now?', images: ['jigitz-afternoon.jpg'], reads: [AFTERNOON] },
    ]);
    expect(b1!.text).toContain('“Balcony: Standing Room Only” at $100.17 a ticket');
    expect(b1!.text).toContain('$200.34 for two');
    expect(b2!.text).toContain('Yes: $214.66 for two is within your $220, with $5.34 to spare.');
    expect(b3!.text).toContain('No, neither fits your $220: GA Ticket Price Tier 3 is $226.58 for two ($6.58 over) and GA Ticket Price Tier 2 is $236.12 for two ($16.12 over).');
    for (const r of [b1!, b2!, b3!]) expect(r.text).not.toMatch(/couldn’t find|couldn't find|Balcony[^\n]*fits your/i);
  });

  it('A02: "we can do $220 for both" is a cap that replaces the earlier one; a later $226.58 floor price is $6.58 over it', async () => {
    const [, c2, c3] = await converse([
      { text: `What's the cheapest floor option for two here? We have $250 for both.\n\n${TM}`, images: ['jigitz-afternoon.jpg'], reads: [AFTERNOON] },
      { text: 'Actually we can do $220 for both, fees in. Does the Tier 3 one fit?', reads: [] },
      { text: 'Tier 3 is $226.58 for the two of us. Does that fit?', reads: [] },
    ]);
    expect(c2!.text).toContain('No: $226.58 for two is $6.58 over your $220.');
    expect(c3!.text).toContain('$6.58 over your $220');
    for (const r of [c2!, c3!]) expect(r.text).not.toMatch(/your \$250|within your \$226/);
  });

  it('B02 (A03/A04): two tiers compared for two in cents, with tax answered separately; by label alone too', async () => {
    const [, b2] = await converse([
      { text: `What's the cheapest floor option for two here?\n\n${TM}`, images: ['jigitz-afternoon.jpg'], reads: [AFTERNOON] },
      { text: "It's the same jigitz event in the link — Brooklyn Paramount tonight. Tier 3 says $113.29 each and Tier 2 says $118.06 each. Which is cheaper for two, and does that include the tax?", reads: [] },
    ]);
    expect(b2!.text).toContain('GA Ticket Price Tier 3 is cheaper: $226.58 for two, against $236.12 for GA Ticket Price Tier 2, so $9.54 less.');
    expect(b2!.text).toContain('Those prices include fees but not tax, so tax is added on top at checkout.');
    const [, l2] = await converse([
      { text: `What's the cheapest floor option for two here?\n\n${TM}`, images: ['jigitz-afternoon.jpg'], reads: [AFTERNOON] },
      { text: 'Tier 2 or tier 3, which is cheaper for the two of us?', reads: [] },
    ]);
    expect(l2!.text).toContain('GA Ticket Price Tier 3 is cheaper: $226.58 for two, against $236.12 for GA Ticket Price Tier 2, so $9.54 less.');
  });

  it('P02 (A05/A06): which product to click on an unpriced artist page, then whether the 2-day ticket splits', async () => {
    const [p1, p2] = await converse([
      { text: 'Hey, which of these should I click if I just want to see Metallica on October 8? Two of us. Just the normal concert, no extras.', images: ['metallica-products.jpg'], reads: [PRODUCTS] },
      { text: 'And can my friend use the other night if I buy the one that covers both?', reads: [] },
    ]);
    expect(p1!.text).toContain('Click “Metallica: Life Burns Faster” on Thu, Oct 8 at 8:30pm: that’s the normal concert ticket for that night.');
    expect(p1!.text).toContain('“Metallica - Suite Reservation” is a suite booking on a partner site, not a standard ticket.');
    expect(p1!.text).toContain('“Metallica 2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day” is one ticket for Thu, Oct 8 to Sat, Oct 10 and can’t be split by day');
    expect(p1!.text).toContain('The promoted “R&B Tour: Usher & Chris Brown” row is an ad for a different show.');
    expect(p1!.text).toContain('doesn’t say whether seats are left');
    expect(p1!.text).not.toMatch(/on general sale|Buy tickets|Oct 3/);
    expect(p2!.text).toContain('I wouldn’t count on it: the page lists it as “Metallica 2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day”');
    expect(p2!.text).toContain('For one night only, “Metallica: Life Burns Faster” on Thu, Oct 8 is the ticket to click.');
  });

  it('S02 (A08): two screenshots of two shows are explained apart, never blended into one request', async () => {
    const [s] = await converse([{ text: "Two totally different possibilities for us: jigitz in Brooklyn or Metallica at Sphere on October 8. Can you explain what each screenshot is offering? We're choosing the show first, not buying both.", images: ['jigitz-morning.jpg', 'metallica-products.jpg'], reads: [MORNING, PRODUCTS] }]);
    expect(s!.text).toContain('These are two different shows, so I’ve kept them apart.');
    expect(s!.text).toContain('jigitz at Brooklyn Paramount, Fri, Oct 2 (doors 8pm, show 9pm): 3 ticket options for two, from $100.17 a ticket (Balcony: Standing Room Only) to $107.33 (GA Ticket Price Tier 2) including fees, before tax: $200.34 to $214.66 for two.');
    expect(s!.text).toMatch(/Metallica at Sphere: an artist page listing[^\n]*“Metallica: Life Burns Faster” \(Thu, Oct 8\)[^\n]*It shows no prices\./);
    expect(s!.text).toContain('Tell me which show you pick');
    // Neither show's facts land on the other.
    expect(s!.text).not.toMatch(/Metallica[^\n]*\$100\.17|jigitz[^\n]*Sphere/);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.state, 'recommendation_sent')).orderBy(t.requests.createdAt).limit(50).then((rs) => rs.slice(-1));
    expect(req!.eventId).toBeNull();
  });

  it('S03 (A07): a sold-out page with a hotel banner is explained without claiming availability', async () => {
    const [s] = await converse([{ text: 'This is what Ticketmaster showed me earlier for Metallica at Sphere on October 8. Does this mean I have to buy a hotel package to get in, or can you find two normal tickets another way?', images: ['metallica-single-night-sold-out.jpg'], reads: [SOLD_OUT] }]);
    expect(s!.text).toContain('When you took the screenshot, the page for Metallica: Life Burns Faster on Thu, Oct 8 said “Tickets are sold out now. Check back soon.”');
    expect(s!.text).toContain('You don’t need a hotel package to get in');
    expect(s!.text).toContain('A screenshot can’t tell me what’s on sale now.');
    expect(s!.text).not.toMatch(/on general sale|Buy tickets|are available|in stock/i);
    const cov = (await h.db.select().from(t.auditLog).where(eq(t.auditLog.action, 'answer.coverage'))).map((r) => r.diff as { route: string; questions: unknown[] });
    expect(cov.at(-1)).toMatchObject({ route: 'evidence_facts', questions: [{ question: 'sold out and hotel packages', status: 'answered' }, { question: 'find two normal tickets another way', status: 'operational_follow_up' }] });
  });

  it('Q01 (A16): "best tickets" asks the goal once; the answer keeps value, seated, no obstruction and $300, and answers both questions', async () => {
    const [q1, q2] = await converse([
      { text: 'Hey, can you find me the best tickets for Metallica at Sphere on October 8?', reads: [] },
      { text: "Best value, two seated tickets. Up to $300 total including fees. We don't want an obstructed view. Is that realistic, and should we wait?", reads: [] },
    ]);
    expect(q1!.text).toContain('Are you after the best view, the best value, or the lowest price?');
    expect(q2!.text).toContain('Sphere, Las Vegas · Thursday, October 8, at 8:30 p.m. · 2 tickets · up to $300 in total');
    expect(q2!.text).toContain('Whether $300 for two is realistic I can’t say yet: I can’t see current prices for this show.');
    expect(q2!.text).toContain('waiting would be a guess');
    expect(q2!.text).toContain('reserved seats, not general admission; $300 in total for both, once fees are added; and an unobstructed view.');
    // Answered questions aren't reopened.
    expect(q2!.text).not.toMatch(/best view, the best value|How many tickets|together\?/);
    // A23: each question's status is kept with the request.
    const cov = (await h.db.select().from(t.auditLog).where(eq(t.auditLog.action, 'answer.coverage'))).map((r) => r.diff as { route: string; questions: Array<{ question: string; status: string }>; gaps: string[] });
    expect(cov.at(-1)).toMatchObject({ route: 'advice_packet', gaps: [], questions: [{ question: 'is the budget realistic', status: 'unsupported' }, { question: 'buy now or wait', status: 'answered' }] });
  });

  it('Q02 (A17): a 12-year-old, Saturday, two tickets and $75 each are kept; a 21+ night is out; age is never called verified', async () => {
    const [nash] = await h.db.insert(t.venues).values({ name: 'QA Launch Nashville Hall', city: 'Nashville', state: 'TN', country: 'US', timezone: 'America/Chicago', latitude: 36.1627, longitude: -86.7816 }).returning();
    const rows: Array<[string, string, string]> = [
      ['QA Launch Country Night', 'country / country', '2026-10-04T01:00:00Z'],
      ['QA Launch Honky Tonk - 21+', 'country / country', '2026-10-04T02:00:00Z'],
      ['QA Launch Americana Sunday', 'country / americana', '2026-10-05T00:00:00Z'],
    ];
    for (const [i, [name, genre, start]] of rows.entries()) {
      const [e] = await h.db.insert(t.events).values({ name, genre, venueId: nash!.id, category: 'concert', localStartAt: new Date(start), status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster' }).returning();
      await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: `LAUNCHNASH${i}`, authoritativeUrl: `https://www.ticketmaster.com/event/LAUNCHNASH${i}`, role: 'discovery', confidence: 'provider_id' });
    }
    const [q1, q2] = await converse([
      { text: "Any good country gigs in Nashville this weekend? I'm taking my 12-year-old daughter. Two tickets, no bars or 21+ shows, under $75 each with fees.", reads: [] },
      { text: 'Just give me your best two options that she can actually get into. Saturday would be ideal.', reads: [] },
    ]);
    expect(q1!.text).toContain('QA Launch Honky Tonk is out: it’s listed as 21+, and one of you is 12.');
    expect(q1!.text).toContain('admission for your 12-year-old (the venue’s age policy) and $150 in total for both, once fees are added');
    expect(q2!.text).toContain('QA Launch Nashville Hall, Nashville · Tomorrow, Saturday, October 3, at 8 p.m. · 2 tickets · up to $150 in total');
    expect(q2!.text).toContain('admission for your 12-year-old (the venue’s age policy)');
    for (const r of [q1!, q2!]) expect(r.text).not.toMatch(/Honky Tonk[^\n]*(?:Tickets|Event page)|age (?:policy )?(?:is )?verified|verified for (?:her|your 12)/i);
  });

  it('quarantine (A preserved): a barcode or ticket screenshot is still quarantined, never answered from', async () => {
    const [s] = await converse([{ text: 'Is 8pm the doors or the show? Here are my tickets.', images: ['jigitz-afternoon.jpg'], reads: [{ ...AFTERNOON, sensitiveContent: true }] }]);
    expect(s!.text).not.toContain('Doors open at 8pm');
  });
});
