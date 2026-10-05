import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';

/**
 * Live, Oct 5 2026 (Elsewhere, Brooklyn): "What shows are happening at elsewhere in brooklyn this week?" got "I checked
 * the official listings and couldn't find any events"; "What about next week?" got "There's one on: Slow Magic w/
 * Maxo". Elsewhere sells most nights through its own site. Then a screenshot of its calendar with "There are shows
 * every day next week. Why are you not suggesting them?" got the same one-show list again. Ticketmaster's one listing
 * is said as that, with Elsewhere's calendar linked, and the calendar they send is answered from.
 */
const NOW = new Date('2026-10-05T15:23:00Z');
const VENUE = '10000000-0000-4000-8000-0000000008e1';
const blank: ListingRead = { kind: 'unrelated', sensitiveContent: false, seller: null, eventName: null, eventDate: null, venue: null, city: null, quantity: null, priceText: null, priceDollars: null, priceBasis: 'unknown', feeBasis: 'unknown', totalDollars: null, section: null, row: null, seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'low', unreadable: [] };
const ev = (name: string, date: string | null, time: string) => ({ name, performer: null, date, time, venue: 'Elsewhere', city: 'Brooklyn', promoted: false });
/** The calendar screenshot as it shows: Elsewhere's rows, the first with its date cut off above. */
const CALENDAR: ListingRead = {
  ...blank, kind: 'event_page', confidence: 'medium', venue: 'Elsewhere', city: 'Brooklyn',
  events: [
    ev('MARSOLO, JACK MARLOW, NATALIA ROTH, BLAISE BRACIC, CUTBACK! + FRIENDS', '2026-10-16', '22:30'),
    ev('TYE TURNER + ZABAAN PRESENTS CLUB CHUTIYA: SRI, ANA.GHA, LILLA, YUVI', '2026-10-17', '22:30'),
    ev('IDA, GARRETT KLAHN (OF TEXAS IS THE REASON)', '2026-10-18', '19:00'),
    ev('ILYKIMCHI', '2026-10-23', '19:00'),
  ],
};

describe('a venue that sells its own nights', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: VENUE, name: 'Elsewhere', city: 'Brooklyn', state: 'NY', country: 'US', timezone: 'America/New_York', latitude: 40.7094, longitude: -73.9232 });
    const [e] = await h.db.insert(t.events).values({ name: 'Slow Magic w/ Maxo', category: 'concert', genre: 'dance/electronic / club dance', venueId: VENUE, localStartAt: new Date('2026-10-16T02:00:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true }).returning();
    await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: 'TMELSE1', authoritativeUrl: 'https://www.ticketmaster.com/event/TMELSE1', role: 'discovery', confidence: 'provider_id' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('this week, next week, then their screenshot of the calendar: Ticketmaster’s one is said as that, and the calendar is answered from', async () => {
    const reader: ListingReader = { name: 'fake', read: async (input) => (input.image ? CALENDAR : blank) };
    const c = makeConcierge(h, { now: () => NOW, listingReader: reader });
    const png = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#f2e8cc' } }).png().toBuffer());
    const turns: Array<{ text: string; image?: boolean }> = [
      { text: 'What shows are happening at elsewhere in brooklyn this week?' },
      // Live: "What about next week?"; the rules reader here doesn't carry a browse into a two-word follow-up (the model does).
      { text: 'What shows are happening at elsewhere next week?' },
      { text: 'There are shows every day next week. WHy are you not suggesting them? https://www.elsewhere.club/events', image: true },
    ];
    let prev: ReturnType<typeof inbound> | null = null;
    const said: string[] = [];
    for (const [i, turn] of turns.entries()) {
      const at = new Date(NOW.getTime() + i * 15 * 60_000);
      const m = inbound({ text: turn.text, from: 'elsewhere-1005@customer.example', subject: prev ? 'Re: (no subject)' : '', receivedAt: at, inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null, attachments: turn.image ? [{ providerAttachmentId: `cal-${i}`, filename: 'calendar.png', declaredMimeType: 'image/png', bytes: png, inline: false }] : [] });
      const before = new Set((await h.db.select({ id: t.sendIntents.id }).from(t.sendIntents)).map((s) => s.id));
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
      const sends = (await h.db.select().from(t.sendIntents)).filter((s) => !before.has(s.id));
      said.push(sends.map((s) => s.bodyText.split('\nTicket Guy\n')[0]).join('\n----\n'));
    }
    const [w1, w2, w3] = said;
    // This week: none on Ticketmaster, said as that, with Elsewhere's own calendar.
    expect(w1).toContain('Ticketmaster lists none of Elsewhere’s nights for');
    expect(w1).toContain('so its own calendar has the full list. Elsewhere’s calendar: https://www.elsewhere.club/events');
    expect(w1).not.toMatch(/I don't have any events/);
    expect(w1).not.toMatch(/couldn't find any events/);
    // Next week: the one Ticketmaster lists, never "there's one on".
    expect(w2).toContain('Slow Magic w/ Maxo');
    expect(w2).toContain('Ticketmaster lists only one of Elsewhere’s nights for');
    expect(w2).not.toMatch(/There’s one on/);
    // The calendar they sent: the miss owned, next week's nights from it, and no repeat of the one-show list.
    expect(w3).toContain('You’re right, I missed these: I only see what Ticketmaster lists, and Elsewhere sells most of its nights itself.');
    expect(w3).toContain('Sat, Oct 17, 10:30pm: Tye Turner + Zabaan Presents Club Chutiya: Sri, Ana.gha, Lilla, Yuvi');
    expect(w3).toContain('Sun, Oct 18, 7pm: Ida, Garrett Klahn (Of Texas Is The Reason)');
    expect(w3).not.toMatch(/Ilykimchi|Oct 23|There’s one on|Slow Magic/);
    expect(w3).toContain('These come from your screenshot, so I can’t see their prices or whether they’re sold out.');
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.state, 'recommendation_sent'));
    expect(req).toBeDefined();
  });
});
