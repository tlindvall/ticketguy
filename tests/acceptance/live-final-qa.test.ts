import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { subtypeFor } from '@/lib/catalog/sync';
import { seedDiscovery } from './r1-discovery.harness';

/**
 * Final real-email QA (Oct 1 2026, deployed 232db3b): the exact customer texts from the Gmail threads, replayed over
 * the Research 1 catalog plus what each case needs. LIVE-01: a "Premium Seating" variant was the game's identity.
 * LIVE-04: "Saturday works better … Elsewhere and Nowadays were preferences, not requirements" still got "Oct 2 to 3
 * at Elsewhere" in New York. LIVE-05: a tribute night was the closest "mainstream pop"; West Hollywood read as Los
 * Angeles. LIVE-06: "which remaining option would you pick?" got another menu. LIVE-07: "section and"; the $60
 * difference; "best tickets" asked everything but the goal. Rules-path extraction, not the production model.
 */
const NOW = new Date('2026-10-01T23:30:00Z');
const F03 = [
  'House or minimal techno in Brooklyn on Friday October 2 or Saturday October 3, 2026. Prefer Elsewhere or Nowadays, but another Brooklyn venue is fine. I am 24 and my friend is 20, so no 21+ nights. We arrive at midnight. Two tickets, $120 TOTAL including fees. Give one or two usable official options and tell me which you would choose. Do not assume age eligibility or midnight entry.',
  "Saturday works better. Another Brooklyn venue is fine; Elsewhere and Nowadays were preferences, not requirements. Keep the same ages, midnight arrival and $120 TOTAL for two. Leave out any 21+ night. If you can't confirm entry for both of us, give me the most useful verified next step instead of making me search again.",
];
const F02 = [
  'Two adults want a mainstream pop concert in Los Angeles on Friday October 9 or Saturday October 10, 2026. Los Angeles only, not Anaheim or Santa Ana. Two reserved seats together, $300 TOTAL including fees. Give one or two official event links and tell me which you would choose. Separate what is verified about seats, adjacency and the total from what is unknown.',
  "Skip The Constellation Room and anything in Santa Ana or Anaheim. Saturday October 10 in Los Angeles is my preference. Keep it to two adults, reserved seats together, $300 TOTAL including fees. Which remaining option would you pick? Don't ask me the genre or dates again.",
];
const F01 = [
  'I’m comparing two quoted options for four at the same Knicks game at Madison Square Garden. Offer A: four ordinary reserved seats together, $520 TOTAL including fees. Offer B: same section and together, $480 TOTAL including fees. Assume those supplied seat and fee facts are correct; I’m asking about the comparison, not live availability. Which would you choose and how much cheaper is it?',
  'Correction: there are six of us. Same event. Offer A is $130 per ticket including fees for six together; Offer B is $120 per ticket including fees for six together. Our cap is $750 TOTAL. Which fits and what is the price difference? These are quotes I’m supplying, not verified live listings.',
];
const F04 = [
  'Six adults want country or Americana in Nashville, Tennessee, on Friday October 2 or Saturday October 3, 2026. Nashville only, not Franklin. Six seats together, $600 TOTAL including fees. No cover bands or country-themed bars. Give one or two original artist events, official links, and which you would choose for us.',
  "Saturday October 3 only now. Keep six seats together and $600 total including fees. Which option would you pick? Don't ask me the genre or dates again.",
];

describe('final real-email QA replays', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; html: string; ack: string };
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const [i, text] of turns.entries()) {
      const m = inbound({ text, from: `live-${n}@customer.example`, subject: prev ? 'Re: Tickets' : 'Tickets', receivedAt: new Date(NOW.getTime() + i * 1000), inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let j = 0; j < 6; j++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(p.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
        }
      }
      const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
      const recs = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
      const body = recs.at(-1)?.bodyText ?? sends.at(-1)?.bodyText ?? '';
      const ack = sends.filter((x) => x.messageClass === 'acknowledgment').at(-1)?.bodyText ?? '';
      out.push({ text: body.split('\nTicket Guy\n')[0]!, html: recs.at(-1)?.bodyHtml ?? sends.at(-1)?.bodyHtml ?? '', ack });
    }
    return out;
  };
  const event = async (name: string, genre: string, venueId: string, start: string, key: string) => {
    const [e] = await h.db.insert(t.events).values({ name, genre, venueId, category: 'concert', localStartAt: new Date(start), status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster' }).returning();
    await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: key, authoritativeUrl: `https://www.ticketmaster.com/event/${key}`, role: 'discovery', confidence: 'provider_id' });
  };

  beforeAll(async () => {
    h = await openTestDb();
    await seedDiscovery(h);
    const venue = async (v: { name: string; city: string; state: string; timezone: string; latitude: number; longitude: number }) => (await h.db.insert(t.venues).values({ ...v, country: 'US' }).returning())[0]!.id;
    const whisky = await venue({ name: 'Whisky A Go Go', city: 'West Hollywood', state: 'CA', timezone: 'America/Los_Angeles', latitude: 34.0906, longitude: -118.3857 });
    await event("Dead Man's Party (Tribute to Oingo Boingo + Danny Elfman), Echoes of Pompeii (Pink Floyd Tribute)", 'rock / pop rock', whisky, '2026-10-11T03:00:00Z', 'LIVETRIB');
    const nash = await venue({ name: 'QA Nashville Room', city: 'Nashville', state: 'TN', timezone: 'America/Chicago', latitude: 36.1627, longitude: -86.7816 });
    await event('QA Nashville Country', 'country / country', nash, '2026-10-04T01:00:00Z', 'LIVENASH1');
    await event('QA Nashville Americana', 'country / americana', nash, '2026-10-04T02:30:00Z', 'LIVENASH2');
    // A second rock night in the city itself, so the Whisky show is one of a list rather than the only pick.
    const [greek] = await h.db.select({ id: t.venues.id }).from(t.venues).where(eq(t.venues.name, 'Greek Theatre'));
    await event('QA LA Rock Night', 'rock / rock', greek!.id, '2026-10-11T02:30:00Z', 'LIVEROCK');
  });
  afterAll(async () => {
    await h.close();
  });

  it('LIVE-01: a "Premium Seating" variant is an add-on, never the game', () => {
    expect(subtypeFor({ name: 'NY Rangers vs New York Islanders Premium Seating', timeTba: false })).toBe('package');
    expect(subtypeFor({ name: 'New York Rangers vs. New York Islanders Club Seats', timeTba: false })).toBe('package');
    expect(subtypeFor({ name: 'New York Rangers vs. New York Islanders', timeTba: false })).toBeNull();
  });

  it('LIVE-04: "Saturday works better … preferences, not requirements" narrows to Saturday and keeps Brooklyn open', async () => {
    const [first, second] = await converse(F03);
    expect(first!.text).toContain('Dusky is out: it’s listed as 21+, and your friend is 20.');
    expect(second!.text).toContain('Night Shift: Deep House at Brooklyn Basement, Sat, Oct 3');
    expect(second!.text).not.toMatch(/at Elsewhere|Oct 2 to 3|in New York|ra\.co/);
    expect(second!.text).toContain('Midnight entry is unverified.');
    expect(second!.text).toContain('Minimum age: unknown.');
  });

  it('LIVE-05: "mainstream pop" never picks a tribute night, and the pick is made when asked', async () => {
    const [first, second] = await converse(F02);
    expect(first!.text).not.toMatch(/Tribute|Whisky/);
    expect(first!.text).toContain('Rachel Bochner');
    expect(second!.text).toContain('Rachel Bochner');
    expect(second!.text).not.toMatch(/Tribute|Whisky|Constellation Room\b(?! is| and)/);
    expect(second!.text).not.toMatch(/Want me to check|Tell me which one/);
  });

  it('a venue outside the city they fenced carries its own city in the list', async () => {
    const [first] = await converse(['Two adults want a rock concert in Los Angeles on Saturday October 10, 2026. Los Angeles only, not Anaheim. Give one or two options.']);
    expect(first!.text).toMatch(/Whisky A Go Go \(West Hollywood\)/);
    expect(first!.text).toMatch(/Greek Theatre\. /);
  });

  it('LIVE-06: "which option would you pick?" on a follow-up gets a pick and the checks, not another menu', async () => {
    const [first, second] = await converse(F04);
    expect(first!.text).toMatch(/two I can check for you/);
    expect(second!.ack).toContain('You asked me to pick, so I’ve gone with QA Nashville Country at QA Nashville Room, Sat, Oct 3: it’s listed as country, the closest to what you asked for. The other I had: QA Nashville Americana at QA Nashville Room (Sat, Oct 3). Say the word and I’ll switch.');
    expect(second!.ack).toContain('Not checked yet: 6 seats together and $600 in total for all 6, once fees are added; I’m checking now.');
    expect(second!.ack).not.toMatch(/Tell me which one|Want me to check/);
  });

  it('LIVE-07: no "section and"; the saving is said even when the other offer is over the cap', async () => {
    const [first, second] = await converse(F01);
    expect(first!.text).toContain('Offer B wins this one: $480 for all four, fees included. That’s $40 less than Offer A.');
    expect(first!.text).not.toContain('section and');
    expect(second!.text).toContain('Offer B is the one that meets what you asked for: $720 for all six, fees included.');
    expect(second!.text).toContain('That’s $60 less than Offer A.');
    expect(second!.text).toContain('Over your $750 budget by $30.');
  });

  it('LIVE-07: "the best tickets" is asked which kind of best, beside the event and party (nothing on file: not the one question)', async () => {
    const [first] = await converse(['Can you find me the best tickets for Dua Lipa?']);
    expect(first!.text).toContain('Are you after the best view, the best value, or the lowest price?');
    expect(first!.text).toMatch(/date and venue|How many tickets/);
  });
});
