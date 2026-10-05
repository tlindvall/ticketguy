import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';

/**
 * Live, Oct 4 2026: a Ticketmaster seat map for Rangers vs. Canucks (Sun Oct 11, 6:00 PM, MSG) with one listing
 * selected: Sec 415, Row 6, "You'll get 2 tickets together in this row", Standard Admission, SUBTOTAL $175.50 for
 * 2 tickets, a $87.75 price bubble over the map, and a "Home Games" sidebar listing six other dates. The read stands in
 * for the production reader as the instructions now ask it to read the page (tests/fixtures/launch-images/
 * rangers-canucks-seatmap.webp; scripts/read-launch-images.ts checks the real reader against the same facts).
 */
const NOW_OCT5 = new Date('2026-10-05T12:52:00Z');
const MSG = '40000000-0000-4000-8000-00000000e101';
const NYR = '40000000-0000-4000-8000-00000000e201';
const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
export const SEATMAP: ListingRead = {
  ...blank, kind: 'ticket_listing', confidence: 'high', seller: 'Ticketmaster', eventName: 'New York Rangers vs. Vancouver Canucks', eventDate: '2026-10-11', eventTime: '18:00',
  venue: 'Madison Square Garden', city: 'New York', quantity: 2, priceText: 'SUBTOTAL $175.50', priceDollars: 175.5, priceBasis: 'whole_party', totalDollars: 175.5,
  section: '415', row: '6', seatsTogether: true, restrictions: ['Mezzanine Level Seating'], listingType: 'primary', admission: 'seated',
};

describe('a Ticketmaster seat map with one listing selected', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: MSG, name: 'Madison Square Garden', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7505, longitude: -73.9934 });
    await h.db.insert(t.entities).values({ id: NYR, kind: 'team', name: 'New York Rangers', slug: 'nyr-seatmap-1004', aliases: ['Rangers'], league: 'NHL', homeVenueId: MSG });
    const games: Array<[string, string, string]> = [['New York Rangers vs. Vancouver Canucks', '2026-10-11T22:00:00Z', 'NYRVAN'], ['New York Rangers vs. Tampa Bay Lightning', '2026-10-13T23:15:00Z', 'NYRTBL'], ['New York Rangers vs. Utah Mammoth', '2026-10-04T22:00:00Z', 'NYRUTA']];
    for (const [name, at, key] of games) {
      const [e] = await h.db.insert(t.events).values({ name, category: 'nhl', venueId: MSG, primaryEntityId: NYR, isHome: true, localStartAt: new Date(at), status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster', saleStatus: 'onsale' }).returning();
      await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: key, authoritativeUrl: `https://www.ticketmaster.com/event/${key}`, role: 'discovery', confidence: 'provider_id' });
    }
  });
  afterAll(async () => {
    await h.close();
  });

  const ask = async (read: ListingRead, from: string, NOW = NOW_OCT5) => {
    const reader: ListingReader = { name: 'fake', read: async (input) => (input.image ? read : blank) };
    const c = makeConcierge(h, { now: () => NOW, listingReader: reader });
    const m = inbound({ text: 'are these good tickets?', from, subject: 'Rangers', receivedAt: NOW, attachments: [{ providerAttachmentId: `att-${from}`, filename: 'rangers.webp', declaredMimeType: 'image/webp', bytes: new Uint8Array(readFileSync(join(__dirname, '../fixtures/launch-images/rangers-canucks-seatmap.webp'))), inline: false }] });
    const r = (await c.ingestInbound(m)) as { requestId: string };
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
    const said = [...(await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))), ...(await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId)))].map((x) => x.bodyText.split('\nTicket Guy\n')[0]).join('\n=====\n');
    return { said, requestId: r.requestId };
  };

  it('read correctly: that game, $87.75 a ticket and $175.50 for two, seated and together; never $175.50 each or another date', async () => {
    const { said } = await ask(SEATMAP, 'seatmap-1004@customer.example');
    expect(said).toContain('New York Rangers vs. Vancouver Canucks\nMadison Square Garden, New York · Sunday, October 11, at 6 p.m. · 2 tickets');
    expect(said).toContain('The screenshot you sent shows $87.75 a ticket on Ticketmaster.');
    expect(said).toContain('That’s 2 tickets, in section 415, row 6, on Ticketmaster, for $175.50 in total.');
    expect(said).not.toMatch(/\$175\.50 a ticket|\$351|Oct(?:ober)? 13|Oct(?:ober)? 4\b|general admission|standing/i);
  });

  // Live Oct 5: the production read took the sidebar's first date ("Oct 4 vs. … Sun • 6:00pm") for the header's game,
  // and the reply was "Two New York Rangers tickets for Sunday, October 4 … couldn't find a New York Rangers
  // performance". The header's matchup names one upcoming game, so its date wins.
  it('read with the sidebar\'s Oct 4: still the Canucks game on Oct 11, never "couldn\'t find" or Oct 4', async () => {
    const { said, requestId } = await ask({ ...SEATMAP, eventDate: '2026-10-04' }, 'seatmap-oct4@customer.example');
    expect(said).toContain('New York Rangers vs. Vancouver Canucks\nMadison Square Garden, New York · Sunday, October 11, at 6 p.m. · 2 tickets');
    expect(said).not.toMatch(/October 4|Oct 4\b|couldn’t find|couldn't find|closest New York Rangers games/i);
    const [fix] = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId, requestId), eq(t.auditLog.action, 'listing.date_corrected')));
    expect(fix!.diff).toMatchObject({ readDate: '2026-10-04', gameDate: '2026-10-11' });
  });
  // Live Oct 4: the same screenshot read with Oct 4, the morning of the Rangers' game against Utah. The header's
  // matchup is the Canucks, so the day's other game is not this one.
  it('read with Oct 4 on Oct 4, when the Rangers play Utah that night: the Canucks game, not Utah', async () => {
    const { said } = await ask({ ...SEATMAP, eventDate: '2026-10-04' }, 'seatmap-oct4-morning@customer.example', new Date('2026-10-04T14:00:00Z'));
    expect(said).toContain('New York Rangers vs. Vancouver Canucks\nMadison Square Garden, New York · Sunday, October 11, at 6 p.m. · 2 tickets');
    expect(said).not.toMatch(/Utah|October 4|tonight/i);
  });
});
