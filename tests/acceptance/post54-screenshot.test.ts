import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { withAttachmentUrls, type ReceivedEmailDetail } from '@/lib/email/resend';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';
import replay from '../fixtures/qa-post54-cases.json';

const CLOCK = new Date(replay.clock);
const LIGHTNING = '20000000-0000-4000-8000-0000000000b1';
const RANGERS_TB = '30000000-0000-4000-8000-0000000000b1';
const body = (id: string) => replay.cases.find((c) => c.id === id)!.body;
const blank: ListingRead = { kind: 'ticket_listing', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'high', unreadable: [] };

/** Stands in for the model reader: a fixed read, and a count of what it was asked to read. */
class FakeReader implements ListingReader {
  readonly name = 'fake';
  calls: Array<'image' | 'text'> = [];
  constructor(private readonly out: ListingRead) {}
  async read(input: { image?: unknown; text?: string | null }): Promise<ListingRead> {
    this.calls.push(input.image ? 'image' : 'text');
    return this.out;
  }
}

/**
 * The two post-#54 failures that go through the listing reader, with a stand-in for the model: A11's
 * screenshot (R3-B09), and R05-F1's correction that the seats aren't wheelchair spaces (R3-B08). Plus the
 * provider step that lost A11's image: the received email lists attachments without a download URL.
 */
describe('post-#54: screenshots and corrections through the listing reader', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.entities).values({ id: LIGHTNING, kind: 'team', name: 'Tampa Bay Lightning', slug: 'tampa-bay-lightning-b', aliases: ['Lightning', 'Tampa Bay'], league: 'NHL' });
    await h.db.insert(t.events).values({ id: RANGERS_TB, name: 'New York Rangers vs. Tampa Bay Lightning', category: 'nhl', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, opponentEntityId: LIGHTNING, isHome: true, localStartAt: new Date('2026-10-01T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' });
  });
  afterAll(async () => {
    await h.close();
  });

  const run = async (c: ReturnType<typeof makeConcierge>) => {
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
  const repliesTo = async (requestId: string) => (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).map((s) => s.bodyText);

  it('A11: the screenshot is read: three together, section 212 row 18, $72 each + $48 per order = $264, obstructed view', async () => {
    const who = 'a11@customer.example';
    const reader = new FakeReader({ ...blank, seller: null, eventName: 'New York Rangers vs. Tampa Bay Lightning', eventDate: '2026-10-01', venue: 'Madison Square Garden', city: 'New York', quantity: 3, priceText: '$72 each + $48 per order', priceDollars: 72, priceBasis: 'per_ticket', feeBasis: 'before_fees', totalDollars: 264, section: '212', row: '18', seatNumbers: ['7', '8', '9'], seatsTogether: true, restrictions: ['Obstructed view'], deliveryText: 'Mobile transfer by 6pm on game day', deliveryBy: '2026-10-01' });
    const c = makeConcierge(h, { listingReader: reader, env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: who }), now: () => CLOCK });
    const png = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ffffff' } }).png().toBuffer());
    const r = (await c.ingestInbound(inbound({ text: body('A11'), from: who, subject: 'Can you read this ticket screenshot?', receivedAt: CLOCK, attachments: [{ providerAttachmentId: 'a11', filename: 'synthetic-offer.png', declaredMimeType: 'image/png', bytes: png, inline: false }] }))) as { requestId: string };
    await run(c);
    expect(reader.calls).toEqual(['image']);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.eventId).toBe(RANGERS_TB);
    const all = (await repliesTo(r.requestId)).join('\n=====\n');
    expect(all).toContain("· 3 tickets");
    expect(all).toContain('Section 212, row 18, seats 7, 8 and 9, together.');
    expect(all).toContain('$264');
    expect(all).toMatch(/obstructed|limited view/i);
    // Its total already carries the $48 order fee: not "fees are extra" under a total that includes them.
    // Their email says it's a synthetic example: its facts, and no checkout or live-market advice (post-#56 QA).
    expect(all).toContain('Since it’s a fictional example, there’s no live offer to check.');
    expect(all).not.toMatch(/Fees are extra|before you pay|resale market/);
    expect(all).not.toMatch(/Two tickets\. Got it|assumed two tickets|Which event/);
  });

  it('R05 then R05-F1: the comparison skips the one-listing read; the correction clears the wheelchair restriction even when the read keeps the word', async () => {
    const who = 'r05@customer.example';
    // The worst case: the reader drops the negation and reports "wheelchair or companion space" as a restriction.
    const reader = new FakeReader({ ...blank, quantity: 2, priceText: '$105 each including all fees', priceDollars: 105, priceBasis: 'per_ticket', feeBasis: 'all_in', totalDollars: 210, section: '211', row: '12', seatsTogether: true, restrictions: ['wheelchair or companion space'], deliveryText: 'Mobile transfer is immediate' });
    const c = makeConcierge(h, { listingReader: reader, env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: who }), now: () => CLOCK });
    const first = inbound({ text: body('R05'), from: who, subject: 'Cheaper wheelchair seats?', receivedAt: CLOCK });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await run(c);
    // Two offers side by side are compared one by one, never read as one listing (R3-B01).
    expect(reader.calls).toEqual([]);
    const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
    await c.ingestInbound(inbound({ text: body('R05-F1'), from: who, subject: 'Re: Cheaper wheelchair seats?', inReplyTo: first.rfcMessageId, references: first.rfcMessageId, receivedAt: CLOCK }));
    await run(c);
    expect(reader.calls).toEqual(['text']);
    const replies = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))).filter((s) => !before.has(s.id)).map((s) => s.bodyText).join('\n=====\n');
    // B alone, from the offers compared before: judged on its own, nothing of A's carried over (live R05-F1).
    expect(replies).toContain('Looking at Offer B on its own, with nothing from Offer A applied: it meets what you asked for, at $210 for both, fees included.');
    expect(replies).not.toMatch(/accessible seats|wheelchair or companion spaces\)|meant for people who need them|I wouldn’t buy this one/);
  });

  it('the received email’s attachments get their download URLs from the attachments endpoint', async () => {
    const detail: ReceivedEmailDetail = { id: 'em_1', from: 'a@b.example', to: [], subject: null, text: 'hi', html: null, headers: {}, message_id: null, in_reply_to: null, references: null, created_at: CLOCK.toISOString(), attachments: [{ id: 'att_1', filename: 'synthetic-offer.png', content_type: 'image/png', size: 75611, download_url: null }] };
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ object: 'list', has_more: false, data: [{ id: 'att_1', filename: 'synthetic-offer.png', size: 75611, content_type: 'image/png', content_disposition: 'attachment', download_url: 'https://inbound-cdn.resend.example/att_1?sig=x', expires_at: '2026-09-30T03:00:00Z' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await withAttachmentUrls('re_key', detail, fetchImpl);
    expect(seen).toEqual(['https://api.resend.com/emails/receiving/em_1/attachments']);
    expect(out.attachments[0]!.download_url).toBe('https://inbound-cdn.resend.example/att_1?sig=x');
    // Nothing to fetch: no call.
    expect(await withAttachmentUrls('re_key', { ...detail, attachments: [] }, fetchImpl)).toMatchObject({ attachments: [] });
    expect(seen).toHaveLength(1);
  });
});
