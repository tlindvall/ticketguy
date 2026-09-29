import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX, FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { ListingImage, ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { REDACTED_NOTE } from '@/lib/intake/pipeline';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';

const blank: ListingRead = { kind: 'ticket_listing', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'high', unreadable: [] };

/** Stands in for the model: returns a fixed read and records what it was shown. */
class FakeReader implements ListingReader {
  readonly name = 'fake';
  seen: Array<ListingImage | null> = [];
  constructor(private readonly out: ListingRead) {}
  async read(input: { image?: ListingImage | null }): Promise<ListingRead> {
    this.seen.push(input.image ?? null);
    return this.out;
  }
}

async function drain(h: DbHandle, c: ReturnType<typeof makeConcierge>) {
  for (let i = 0; i < 10; i++) {
    const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
    if (!leased.length) return;
    for (const ev of leased) {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
      await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
    }
  }
}

const png = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#ffffff' } }).png().toBuffer().then((b) => new Uint8Array(b));

/**
 * "Send your ticket link or screenshot": the screenshot is read for what it shows, kept as evidence of what was
 * displayed (never a verified offer), and the reply says what it showed, what to check, and what it didn't say.
 */
describe('reading the listing a customer sends', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('a screenshot settles the game and the price, and the reply names the source and the catches', async () => {
    const reader = new FakeReader({ ...blank, seller: 'StubHub', eventName: 'New York Rangers vs. New York Islanders', eventDate: '2026-10-03', quantity: 2, priceText: '$245 ea incl. fees', priceDollars: 245, priceBasis: 'per_ticket', feeBasis: 'all_in', section: '212', row: 'D' });
    const c = makeConcierge(h, { listingReader: reader, env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'shot@customer.example' }) });
    const r = (await c.ingestInbound(inbound({ text: 'Is this a good price?', from: 'shot@customer.example', subject: 'Tickets', attachments: [{ providerAttachmentId: 'a1', filename: 'listing.png', declaredMimeType: 'image/png', bytes: await png(), inline: false }] }))) as { requestId: string };
    await drain(h, c);

    // The model was shown a re-encoded JPEG, not the original file.
    expect(reader.seen).toHaveLength(1);
    expect(reader.seen[0]!.mimeType).toBe('image/jpeg');

    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(req!.eventId).toBe(FX.events.rangersPreseason);
    const [ev] = await h.db.select().from(t.listingEvidence).where(eq(t.listingEvidence.requestId, r.requestId));
    expect(ev).toMatchObject({ source: 'screenshot', sensitive: false, kind: 'ticket_listing', observedAt: FIXTURE_NOW });
    expect(ev!.fields).toMatchObject({ perTicketCents: 24500, wholePartyCents: 49000, section: '212', row: 'D', seatNumbers: null, seatsTogether: null });

    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    const body = rec!.bodyText;
    expect(body).toContain('The screenshot you sent shows $245 a ticket including fees on StubHub. That’s what the listing showed when you took it; I haven’t checked that the seats are still there.');
    expect(body).toContain('That’s 2 tickets, in section 212, row D, on StubHub, for $490 in total including fees.');
    expect(body).toContain('Worth checking before you buy:');
    expect(body).toContain('- It doesn’t say the seats are together. Check before you buy if that matters.');
    expect(body).toContain('- It doesn’t say when the tickets will be delivered.');
    expect(body).toContain('- It doesn’t show seat numbers, so you won’t know exactly where you’re sitting until after you buy.');
    // A verified option (staff-checked here) that is cheaper comes first, with the difference for the whole party.
    expect(body.startsWith('Hey,\n\nI’d look at the verified option below first: it’s $250 less for both.')).toBe(true);
    expect(body).toContain('including the verified charges, checked Sep 22, 11:00 AM EDT.');
    expect(body).not.toContain('I can’t see what sellers are charging');
  });

  it('a screenshot showing a barcode or card is deleted unused, and the customer is told why', async () => {
    const reader = new FakeReader({ ...blank, kind: 'purchased_ticket', sensitiveContent: true });
    const c = makeConcierge(h, { listingReader: reader });
    const r = (await c.ingestInbound(inbound({ text: 'Two Rangers tickets Oct 3, is $150 each ok?', from: 'barcode@customer.example', subject: 'Tickets', attachments: [{ providerAttachmentId: 'a2', filename: 'ticket.png', declaredMimeType: 'image/png', bytes: await png(), inline: false }] }))) as { requestId: string };
    await drain(h, c);
    const [ev0] = await h.db.select().from(t.listingEvidence).where(eq(t.listingEvidence.requestId, r.requestId));
    const atts = await h.db.select().from(t.attachments).where(eq(t.attachments.messageId, ev0!.messageId));
    expect(atts[0]).toMatchObject({ validationState: 'quarantined', validationReason: 'sensitive_content', mediaId: null });
    const [ev] = await h.db.select().from(t.listingEvidence).where(eq(t.listingEvidence.requestId, r.requestId));
    expect(ev).toMatchObject({ sensitive: true, fields: null });
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    expect(sends.some((s) => s.bodyText.includes(REDACTED_NOTE))).toBe(true);
  });

  it('pasted listing text is read the same way and said to be what they pasted', async () => {
    const reader = new FakeReader({ ...blank, seller: 'Vivid Seats', quantity: 2, priceText: '$180 each + fees', priceDollars: 180, priceBasis: 'per_ticket', feeBasis: 'before_fees', section: '118', row: '12', seatNumbers: ['7', '8'], seatsTogether: true, deliveryBy: '2026-10-01' });
    const c = makeConcierge(h, { listingReader: reader });
    const r = (await c.ingestInbound(inbound({ text: 'Rangers Oct 3. Found this: Sec 118 Row 12, seats 7-8, $180 each + fees on Vivid. Worth it?', from: 'pasted@customer.example', subject: 'Rangers' }))) as { requestId: string };
    await drain(h, c);
    expect(reader.seen).toEqual([null]); // text only, no image
    const [ev] = await h.db.select().from(t.listingEvidence).where(eq(t.listingEvidence.requestId, r.requestId));
    expect(ev).toMatchObject({ source: 'listing_text', attachmentId: null });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    expect(rec!.bodyText).toContain('The listing you pasted shows $180 a ticket before fees on Vivid Seats.');
    expect(rec!.bodyText).toContain('- Fees are extra, so the total at checkout will be higher than the listed price.');
    expect(rec!.bodyText).not.toContain('doesn’t say the seats are together');
  });

  it('without a reader (fixture mode) a screenshot is kept unread and nothing is guessed', async () => {
    const c = makeConcierge(h);
    const r = (await c.ingestInbound(inbound({ text: 'Two Rangers tickets Oct 3 please', from: 'noreader@customer.example', subject: 'Tickets', attachments: [{ providerAttachmentId: 'a3', filename: 'x.png', declaredMimeType: 'image/png', bytes: await png(), inline: false }] }))) as { requestId: string };
    await drain(h, c);
    expect(await h.db.select().from(t.listingEvidence).where(eq(t.listingEvidence.requestId, r.requestId))).toHaveLength(0);
  });
});
