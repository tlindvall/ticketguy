import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { inbound, makeConcierge, openTestDb } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { runThread, type Scenario, type TurnOut } from '../../evals/harness';
import { AS_OF, EV } from '../../evals/world';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { withoutAttachmentNames } from '@/lib/intake/threading';
import { saysADay } from '@/lib/domain/dates';

/**
 * #177, from real threads (their wording stays private; everything here is invented):
 * - "are these good?" with a checkout screenshot was bound to a day the page doesn't show (the screenshot's file name
 *   and a "Home Games" side list both named other days), so the reply asked for a link instead of judging the seats;
 * - a correction of what kind of event it is was ignored, and "which date, Thursday or Saturday?" got the previous
 *   email again, word for word.
 */
const answer = (t: TurnOut) => t.emails.at(-1)?.text ?? '';

class FixedReader implements ListingReader {
  readonly name = 'fixed';
  constructor(private readonly out: ListingRead) {}
  async read(): Promise<ListingRead> {
    return this.out;
  }
}

describe('a screenshot is dated by its own header (#177)', () => {
  it('drops attachment names from what the customer said', () => {
    const clean = (x: string) => withoutAttachmentNames(x).trim();
    expect(clean('are these ok?\n\n[image: Screenshot 2026-10-17 at 11.40.02 PM.png]')).toBe('are these ok?');
    expect(clean('thoughts? <image001.png>')).toBe('thoughts?');
    expect(clean('IMG_4810.png\nis this a good price')).toBe('is this a good price');
    expect(clean('meet at 7.30pm, ok?')).toBe('meet at 7.30pm, ok?');
  });

  it.each([['are these any good?', false], ['are these good for saturday?', true], ['the oct 22 game, good seats?', true], ['tickets for tonight ok?', true], ['2 tickets, 3rd row', true]])('"%s" names a day: %s', (text, says) => expect(saysADay(text)).toBe(says));

  it('"are these any good?" binds the game on the page and judges its seats', async () => {
    // What the page shows (header: Rangers vs. Bruins, Thu Oct 22; Sec 224 Row G, 2 standard tickets at $130 each).
    const read: ListingRead = { kind: 'checkout', sensitiveContent: false, seller: 'Ticketmaster', eventName: 'New York Rangers vs. Boston Bruins', eventDate: '2026-10-22', venue: 'Madison Square Garden', city: 'New York', quantity: 2, priceText: '$130.00 each', priceDollars: 130, priceBasis: 'per_ticket', feeBasis: 'unknown', totalDollars: 260, section: '224', row: 'G', seatNumbers: null, seatsTogether: true, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'high', unreadable: [], listingType: 'primary' };
    const s: Scenario = { id: 'local/good-tickets-shot', capability: 'screenshots', now: AS_OF.rangersWeek, steps: [{ text: 'are these any good?\n\n[image: Screenshot 2026-10-17 at 11.40.02 PM.png]', screenshots: [{ marketplace: 'Ticketmaster', event: 'New York Rangers vs. Boston Bruins', when: 'Thu, Oct 22 · 7:00 PM · Madison Square Garden', section: '224', row: 'G', quantity: 2, totalDollars: 260, feesIncluded: false, sidebar: ['Sat, Oct 17 vs Devils'] }] }] };
    const [turn] = (await runThread(s, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), listingReader: new FixedReader(read) })) as [TurnOut];
    expect(turn.eventId).toBe(EV.rangersBruins);
    const reply = answer(turn);
    expect(reply).not.toMatch(/October 17|Oct 17|send me the link/);
    expect(reply).toMatch(/Section 224, row G .*is in the upper level at Madison Square Garden/);
    expect(reply).toMatch(/standard tickets from the official sale on Ticketmaster, not resale/);
  }, 60_000);
});

describe('a follow-up to the official-sale reply is answered, not repeated (#177)', () => {
  // Invented act and venue: a band with two nights at an arena, both on general sale.
  const VENUE = '10000000-0000-4000-8000-0000000001a1';
  const BAND = '20000000-0000-4000-8000-0000000001a1';
  const THU = '30000000-0000-4000-8000-0000000001a1';
  const SAT = '30000000-0000-4000-8000-0000000001a2';
  let h: Awaited<ReturnType<typeof openTestDb>>;
  const drain = async (c: ReturnType<typeof makeConcierge>) => {
    for (let i = 0; i < 6; i++) {
      const work = (await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW })).filter((ev) => ev.eventType === 'request.interpret');
      if (!work.length) return;
      for (const ev of work) {
        const p = ev.payload as Record<string, string>;
        await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
  };
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: VENUE, name: 'Harborview Arena', city: 'New Haven', state: 'CT', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: BAND, kind: 'performer', name: 'The Lanterns', slug: 'the-lanterns', aliases: ['Lanterns'] });
    const show = (id: string, at: string, tm: string) => ({ id, name: 'The Lanterns', category: 'concert', venueId: VENUE, primaryEntityId: BAND, localStartAt: new Date(at), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: true, saleStatus: 'onsale', publicSaleStartAt: new Date('2026-08-01T14:00:00Z'), publicSaleEndAt: null, tm });
    const rows = [show(THU, '2026-11-20T01:00:00Z', 'LAN1'), show(SAT, '2026-11-22T01:00:00Z', 'LAN2')];
    await h.db.insert(t.events).values(rows.map(({ tm: _tm, ...e }) => e));
    await h.db.insert(t.eventSourceMappings).values(rows.map((e) => ({ eventId: e.id, sourceId: 'ticketmaster', sourceEventId: e.tm, authoritativeUrl: `https://www.ticketmaster.com/the-lanterns/event/${e.tm}`, role: 'discovery', confidence: 'provider_id' })));
  });
  afterAll(async () => {
    await h.close();
  });

  const thread = async (who: string, texts: string[]) => {
    const c = makeConcierge(h);
    const first = inbound({ text: texts[0]!, from: who, subject: 'Lanterns' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await drain(c);
    for (const text of texts.slice(1)) {
      await c.ingestInbound(inbound({ text, from: who, subject: 'Re: Lanterns', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
      await drain(c);
    }
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId)).orderBy(asc(t.sendIntents.createdAt));
    return sends.map((s) => s.bodyText);
  };

  it('owns a correction of what kind of event it is, and answers "which night?" with both nights', async () => {
    const [one, two, three] = await thread('lanterns@customer.example', [
      '2 Lanterns tickets for Nov 19 please',
      'just so you know, it is not a game, it is a concert',
      'wait, which one are we talking about, Thursday Nov 19 or Saturday Nov 21?',
    ]);
    expect(one).toMatch(/is still on general sale on Ticketmaster/);
    expect(two).toMatch(/You’re right: it’s a concert, not a game\./);
    expect(three).toMatch(/Both: there’s a show at Harborview Arena on Thursday, November 19 and on Saturday, November 21\. This email is about Thursday, November 19; reply with “Saturday”/);
    expect(two).not.toBe(one);
    expect(three).not.toBe(two);
  }, 60_000);

  it('says plainly when one of the two nights asked about isn’t on file', async () => {
    const [, two] = await thread('lanterns2@customer.example', ['2 Lanterns tickets for Nov 19 please', 'is it the Thursday Nov 19 or the Sunday Nov 22 show?']);
    expect(two).toMatch(/The one I have on file is Thursday, November 19 at Harborview Arena\. I don’t have a show there on Sunday, November 22/);
  }, 60_000);

  it('a follow-up with nothing to answer says nothing has changed, instead of the same email again', async () => {
    const [one, two] = await thread('lanterns3@customer.example', ['2 Lanterns tickets for Nov 19 please', 'ok and the tickets?']);
    expect(two).toMatch(/^Hey,\n\nNothing has changed since my last email\./);
    expect(two).not.toBe(one);
  }, 60_000);
});
