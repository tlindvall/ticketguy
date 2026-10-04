import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { ListingImage, ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { isAgainstPlace } from '@/lib/domain/matchup';
import { FX } from '@/lib/fixtures';
import { openTestDb, makeConcierge, inbound, testEnv } from '../harness';

/**
 * Live, Oct 4 2026: a Ticketmaster screenshot of a Rangers game (Mezzanine, Sec 415, Row 6, two tickets, $175.50) and
 * "are these good tickets?" got "I searched Ticketmaster's listings and couldn't find a New York Rangers performance in
 * New York, NY on Sun, Oct 4", then "send me the link". The Rangers play the Utah Mammoth at the Garden that night. The
 * page shows its schedule with opponents as logos, and an opponent read off a logo, or by a team's old name, was a hard
 * filter that ruled the night's only game out. The team and the date the screenshot shows now settle it.
 */
const NOW = new Date('2026-10-04T04:10:00Z');
const MSG = FX.venues.msg;
const RANGERS = FX.entities.rangers;
const TONIGHT = '30000000-0000-4000-8000-0000000002a1';

const blank: ListingRead = { kind: 'ticket_listing', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'high', unreadable: [] };
class FakeReader implements ListingReader {
  readonly name = 'fake';
  constructor(private readonly out: ListingRead) {}
  async read(_input: { image?: ListingImage | null }): Promise<ListingRead> {
    return this.out;
  }
}
const png = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#ffffff' } }).png().toBuffer().then((b) => new Uint8Array(b));

describe('a screenshot of a game we have', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    const game = (name: string, at: string) => ({ name, category: 'nhl', venueId: MSG, primaryEntityId: RANGERS, localStartAt: new Date(at), status: 'scheduled' as const, verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale' as const, isHome: true });
    await h.db.insert(t.events).values([
      { ...game('New York Rangers vs. Utah Mammoth', '2026-10-04T22:00:00Z'), id: TONIGHT },
      game('New York Rangers vs. New York Islanders', '2026-10-06T23:00:00Z'),
      game('New York Rangers vs. Vancouver Canucks', '2026-10-11T22:00:00Z'),
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  let seq = 0;
  const send = async (read: ListingRead) => {
    seq += 1;
    const from = `shot${seq}@customer.example`;
    const c = makeConcierge(h, { listingReader: new FakeReader(read), now: () => NOW, env: testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: from }) });
    const r = (await c.ingestInbound(inbound({ text: 'are these good tickets?', from, subject: '', receivedAt: NOW, attachments: [{ providerAttachmentId: `a${seq}`, filename: 'listing.png', declaredMimeType: 'image/png', bytes: await png(), inline: false }] }))) as { requestId: string };
    for (let i = 0; i < 10; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
      }
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
    return { req: req!, body: sends.map((s) => s.bodyText).join('\n----\n') };
  };
  const shot: ListingRead = { ...blank, seller: 'Ticketmaster', eventDate: '2026-10-04', venue: 'Madison Square Garden', city: 'New York', quantity: 2, priceText: '$175.50 subtotal, 2 tickets', totalDollars: 175.5, priceBasis: 'whole_party', feeBasis: 'unknown', section: '415', row: '6', seatsTogether: true };

  it('an opponent read by its old name: the night’s game, said so, never "couldn’t find"', async () => {
    const r = await send({ ...shot, eventName: 'New York Rangers vs. Utah Hockey Club' });
    expect(r.req.eventId).toBe(TONIGHT);
    expect(r.body).not.toMatch(/couldn't find|send me the link/);
  });

  it('an opponent read off the wrong logo: the team and the date win, and the reply says which game it took', async () => {
    const r = await send({ ...shot, eventName: 'New York Rangers vs. Boston Bruins' });
    expect(r.req.eventId).toBe(TONIGHT);
    expect(r.body).toContain('Your screenshot looked to me like the Boston Bruins game, but the New York Rangers’ game that day is against the Utah Mammoth, so I’ve gone with that one.');
    expect(r.body).not.toMatch(/couldn't find|send me the link/);
  });

  it('a day with no game: the nearest games to choose from, not a dead end', async () => {
    const r = await send({ ...shot, eventName: 'New York Rangers vs. Utah Mammoth', eventDate: '2026-10-05' });
    expect(r.req.eventId).toBeNull();
    expect(r.body).toContain('The closest New York Rangers games I have:\n• Tonight at 6 p.m.: New York Rangers vs. Utah Mammoth, Madison Square Garden\n• Tuesday, October 6, at 7 p.m.: New York Rangers vs. New York Islanders, Madison Square Garden\n• Sunday, October 11, at 6 p.m.: New York Rangers vs. Vancouver Canucks, Madison Square Garden');
    expect(r.body).toContain('Is it one of those? Tell me which and I’ll take it from there.');
    expect(r.body).not.toMatch(/send me the link/);
  });

  it('a renamed team is the same place, and the performer’s own city never counts', () => {
    expect(isAgainstPlace('New York Rangers vs. Utah Mammoth', 'Utah Hockey Club', 'New York Rangers')).toBe(true);
    expect(isAgainstPlace('New York Rangers vs. Utah Mammoth', 'New York Islanders', 'New York Rangers')).toBe(false);
    expect(isAgainstPlace('New York Rangers vs. Boston Bruins', 'Utah Mammoth', 'New York Rangers')).toBe(false);
  });
});
