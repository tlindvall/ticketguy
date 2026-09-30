import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import replay from '../fixtures/qa-0930-cases.json';
import sharp from 'sharp';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';

/**
 * The Sep 30 morning live QA after #55 (27 sends, 19 threads), replayed word for word in send order, with the
 * whole reply read, not its first line. A11's image goes through a stand-in reader that makes the live model's
 * mistake (calling the $72 base price all-in), so the price guard is tested, not the model.
 * Harness as in post54-replay.test.ts.
 * The TGQA-0929 audit, replayed word for word (tests/fixtures/audit-0929-cases.json: the 11 first emails and 5
 * follow-ups in send order, addresses and ids removed). The clock is the audit's, the events are the ones it
 * asked about, and the extractor is the deterministic one, so this checks what the pipeline does with each
 * request, not what a model reads into it. Each case asserts the audit's invariant for it, not exact copy.
 */
const CLOCK = new Date(replay.clock);
const FROM = 'qa-replay@customer.example';
const RODGERS = '10000000-0000-4000-8000-0000000000a1';
const LIGHTNING = '20000000-0000-4000-8000-0000000000a1';
const HAMILTON = '20000000-0000-4000-8000-0000000000a2';
const RANGERS_TB = '30000000-0000-4000-8000-0000000000a1';
const HAMILTON_OCT3 = '30000000-0000-4000-8000-0000000000a2';

type Case = (typeof replay.cases)[number];
const wrap = (s: string) => s.replace(/(.{1,76})(\s+|$)/g, '$1\n').trim();
const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
/** A11's synthetic image, read the way the live model read it: the $72 base price called all-in. */
class A11Reader implements ListingReader {
  readonly name = 'fake';
  async read(input: { image?: unknown }): Promise<ListingRead> {
    if (!input.image) return blank;
    return { ...blank, kind: 'ticket_listing', confidence: 'high', eventName: 'New York Rangers vs. Tampa Bay Lightning', eventDate: '2026-10-01', venue: 'Madison Square Garden', city: 'New York', quantity: 3, priceText: '$72 each + $48 per order', priceDollars: 72, priceBasis: 'per_ticket', feeBasis: 'all_in', totalDollars: 264, section: '212', row: '18', seatNumbers: ['7', '8', '9'], seatsTogether: true, restrictions: ['Obstructed view'], deliveryText: 'Mobile transfer, delivery by 6pm on game day', deliveryBy: '2026-10-01' };
  }
}
const byId = (id: string) => replay.cases.find((c) => c.id === id)!;

describe('the Sep 30 live QA (post-#55), replayed exactly', () => {
  let h: DbHandle;
  const replies = new Map<string, string[]>();
  const requestOf = new Map<string, string>();

  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: RODGERS, name: 'Richard Rodgers Theatre', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7593, longitude: -73.9866 });
    await h.db.insert(t.entities).values([
      { id: LIGHTNING, kind: 'team', name: 'Tampa Bay Lightning', slug: 'tampa-bay-lightning', aliases: ['Lightning', 'Tampa Bay'], league: 'NHL' },
      { id: HAMILTON, kind: 'artist', name: 'Hamilton', slug: 'hamilton', aliases: ['Hamilton on Broadway'] },
    ]);
    await h.db.insert(t.events).values([
      { id: RANGERS_TB, name: 'New York Rangers vs. Tampa Bay Lightning', category: 'nhl', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, opponentEntityId: LIGHTNING, isHome: true, localStartAt: new Date('2026-10-01T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' },
      { id: HAMILTON_OCT3, name: 'Hamilton', category: 'theatre', venueId: RODGERS, primaryEntityId: HAMILTON, localStartAt: new Date('2026-10-03T18:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-01-01T15:00:00Z'), publicSaleEndAt: new Date('2026-10-03T17:00:00Z') },
    ]);
    await h.db.insert(t.eventSourceMappings).values({ eventId: HAMILTON_OCT3, sourceId: 'ticketmaster', sourceEventId: 'Z1r9uZrrZbpZ1AvjMjk', authoritativeUrl: 'https://www.ticketmaster.com/hamilton-ny-new-york-new-york-10-03-2026/event/Z1r9uZrrZbpZ1AvjMjk', role: 'discovery', confidence: 'provider_id' });

    const c = makeConcierge(h, { env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: FROM }), now: () => CLOCK, listingReader: new A11Reader() });
    const png = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } }).png().toBuffer());
    const firstMsg = new Map<string, string>();
    const drain = async () => {
      for (let i = 0; i < 10; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: CLOCK });
        if (!leased.length) return;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, CLOCK);
        }
      }
    };
    // In send order, each follow-up in its case's thread, one at a time, as the audit sent them.
    for (const k of replay.cases as Case[]) {
      const parent = k.parent ? firstMsg.get(k.parent) : undefined;
      const attachments = k.attachment ? [{ providerAttachmentId: 'att-a11', filename: 'synthetic-offer.png', declaredMimeType: 'image/png', bytes: png, inline: false }] : [];
      // Live text arrives wrapped (generated from the HTML at about 76 characters): so does the replay's.
      const msg = inbound({ text: wrap(k.body), from: FROM, subject: k.subject, inReplyTo: parent ?? null, references: parent ?? null, attachments });
      if (!k.parent) firstMsg.set(k.id, msg.rfcMessageId!);
      const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
      const r = (await c.ingestInbound(msg)) as { requestId?: string };
      if (r.requestId) requestOf.set(k.id, r.requestId);
      await drain();
      const after = await h.db.select().from(t.sendIntents);
      replies.set(k.id, after.filter((s) => !before.has(s.id)).map((s) => s.bodyText));
    }
  });
  afterAll(async () => {
    await h.close();
  });

  const all = (id: string) => (replies.get(id) ?? []).join('\n\n=====\n\n');

  it('every replayed email got an answer', () => {
    for (const k of replay.cases) expect(replies.get(k.id)?.length, k.id).toBeGreaterThan(0);
  });

  it('X02 and its reordered, reworded twin M01 pick the same offer by its terms, not its position (R4-B01)', () => {
    expect(all('X02')).toContain('Offer B is the one that meets what you asked for: $585 for all five, fees included. That’s $65 less than Offer A.');
    const m01 = all('M01');
    expect(m01).toContain('Offer D is the one that meets what you asked for: $585 for all five, fees included.');
    expect(m01).toContain('It’s six tickets the seller won’t split, and you won’t buy an extra.');
    expect(m01).not.toMatch(/Offer B costs less|\$480 for all five/);
  });

  it('M01-F1: buying six becomes allowed, the same offers are judged again: B at $480, $105 less than D (R4-B04)', () => {
    const body = all('M01-F1');
    expect(body).toContain('Offer B wins this one: $480 for six tickets, fees included. That’s $105 less than Offer D.');
    expect(body).not.toMatch(/I haven’t been able to check these against any seats|Found seats you like/);
  });

  it('M03: none fits, each for its own reason, and the smallest change is named; M03-F1 at $230 picks A, keeping noon (R4-B02)', () => {
    const m03 = all('M03');
    expect(m03).toContain('None of these meets all your requirements. The smallest change: if you can stretch to $230 in total, Offer A meets everything else.');
    expect(m03).toContain('Delivery by 6pm misses your noon deadline.');
    expect(m03).not.toMatch(/Offer B is the one|On delivery:/);
    const f1 = all('M03-F1');
    expect(f1).toContain('Offer A is the one that meets what you asked for: $230 for both, fees included.');
    expect(f1).toContain('Delivery by 6pm misses your noon deadline.');
  });

  it('X01: the per-order fee and fee-inclusive price compare: B saves $10; no market floor in the answer (R4-B03)', () => {
    const body = all('X01');
    expect(body).toContain('Offer B wins this one: $210 for both, fees included. That’s $10 less than Offer A.');
    expect(body).not.toMatch(/aren’t on the same basis|resale market|Lowest asking price/);
  });

  it('M02: an unknown fee is a break-even, not a fit: A beats B only under $40 in fees (R4-B03)', () => {
    const body = all('M02');
    expect(body).toContain('Offer A only beats it if its fees come to less than $40 in total: at $40 they tie, and above that B costs less.');
    expect(body).toContain('It fits your $250 only if its fees come to $80 or less.');
    expect(body).not.toMatch(/Offer A and Offer B meet what you asked for/);
  });

  it('A11: one price object: $72 before fees + $48 = $264, $88 each all-in, delivery by 6pm (R4-B03)', () => {
    const body = all('A11');
    expect(body).toContain('The example image shows three tickets: $264 in total, $88 each including fees.');
    expect(body).toContain('$72 × 3, plus $48 in fees for the whole order.');
    expect(body).toContain('delivery by 6pm');
    expect(body).not.toContain('$72 a ticket including fees');
    expect(body).not.toMatch(/could seat all three|look at how the tickets are trading/);
  });

  it('A11-F1: the correction is acknowledged first and the summary is the corrected one (R4-B04)', () => {
    const body = all('A11-F1');
    // The image was read right the first time, so their restatement is confirmed, not called an update (TGQA-R6 15).
    expect(body.indexOf('Your numbers match what I read. The example image shows three tickets: $264 in total, $88 each including fees.')).toBeGreaterThan(0);
    expect(body).not.toContain('Updated from your email');
    expect(body).toContain('$88 each including fees');
    expect(body).not.toMatch(/\$72 a ticket including fees|72 tickets|up to \$216/);
  });

  it('G03: already bought, asking about entry: official-transfer guidance with its sources, no event intake (R4-B06)', () => {
    const body = all('G03');
    expect(body).toContain('Ask the seller for an official mobile transfer; don’t count on the PDF or screenshot of the barcode to get you in.');
    expect(body).toContain('https://blog.ticketmaster.com/new-mobile-ticket-safety/');
    expect(body).toContain('https://assets.msg.com/uploads/2025/03/Mobile-Ticketing-Tutorial.pdf');
    expect(body).toContain('ask them to transfer both tickets to your account');
    expect(body).not.toMatch(/Which event|assumed two tickets|resale market|Found seats you like/);
  });

  it('R05-F1: assessing B alone, no before-fees "cheaper listing" headline (R4-B07)', () => {
    expect(all('R05-F1')).not.toMatch(/have a look at the cheaper listings|Offer A \(wheelchair/);
  });

  it('prints', () => {
    if (process.env.PRINT_REPLAY) writeFileSync(process.env.PRINT_REPLAY, replay.cases.map((k) => `##### ${k.id}\n${all(k.id)}`).join('\n\n'));
    expect(byId('M01')).toBeDefined();
  });
});
