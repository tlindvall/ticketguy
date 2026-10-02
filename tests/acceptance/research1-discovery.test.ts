import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { eventConstraints } from '@/lib/domain/event-constraints';
import { seedDiscovery } from './r1-discovery.harness';

/**
 * Research 1 discovery regression (Oct 1 2026, build 9eb3679): the exact live texts for Austin and LA, over the
 * catalog their captured replies show, with the controls the report asks for. NW-02: a venue the customer corrects
 * ("Constellation Room is in Santa Ana, not Los Angeles. No Orange County") became the venue searched, then a
 * Friday show there was offered. R1-DISCOVERY-DATES-01: "Friday Oct 2 or Saturday Oct 3 ... don't quietly
 * broaden the dates" got Oct 7, 8, 20 and 23. R1-DISCOVERY-CLOSURE-01 / R2-EMAIL-HIERARCHY-01: three shows for
 * "one or two", a long bold caveat, and "check it against those". Rules-path extraction, not the production model.
 */
const NOW = new Date('2026-10-01T18:50:00Z');
const AUSTIN = [
  'Hey Ticket Guy, two adults looking for an actual country or Americana artist in Austin, Texas, on Friday October 2 or Saturday October 3, 2026. Not a cover band, country-themed bar or an event outside Austin. We\'d like to keep it under $150 TOTAL for both including fees. Give me one or two real options and tell me which you\'d pick and why. If you can\'t verify the price or admission, just say what you do know and include the official event link. Please don\'t quietly broaden the dates or city.',
  'No rock or pop alternatives please. You only listed Friday, but Saturday October 3 was also allowed. Please check Austin country or Americana for Saturday October 3 specifically. If you have no suitable listings in your sources, just say that. Can you explain whether you checked both dates and Americana as well as country, rather than sending everything on? Keep the $150 total budget for two; don\'t say it\'s met unless you know the price.',
];
const LA = [
  'Two adults looking for a mainstream pop concert in Los Angeles on Friday October 9 or Saturday October 10, 2026, under $300 TOTAL for both including fees. We need seats, not standing-only admission, and don\'t want to travel to Anaheim. Name one or two suitable shows with official links and tell me which you\'d choose. Please separate what you verified from what still needs checking: if reserved seats, adjacent seats or the total aren\'t known, don\'t describe the show as meeting those requirements. No tribute acts or DJ parties in place of the original artist.',
  'Constellation Room is in Santa Ana, not Los Angeles. No Orange County please. Can you check Saturday October 10 specifically now? We still need seats and a $300 total cap for two. Which option would you choose for us, and are reserved seats, seats together and the all-in total verified or not yet checked? Please answer those points instead of just giving me another list.',
];
const LATER = /Kacey Musgraves|THE CHICKS|Cameron Whitcomb|next ones after that/;

describe('Research 1 discovery: hard dates, exclusions and a finished decision', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; html: string };
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const text of turns) {
      const m = inbound({ text, from: `r1d-${n}@customer.example`, subject: prev ? 'Re: Tickets' : 'Tickets', inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let i = 0; i < 6; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: NOW });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
        }
      }
      const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
      out.push({ text: sends.at(-1)!.bodyText.split('\nTicket Guy\n')[0]!, html: sends.at(-1)!.bodyHtml });
    }
    return out;
  };
  beforeAll(async () => {
    h = await openTestDb();
    await seedDiscovery(h);
  });
  afterAll(async () => {
    await h.close();
  });

  describe('R1-DISCOVERY-DATES-01: Austin, Oct 2 or 3, no quiet broadening', () => {
    it('both turns say no match on their nights, name what was checked, and offer no later dates', async () => {
      const [first, second] = await converse(AUSTIN);
      expect(first!.text.split('\n\n')[1]).toBe('I don’t have a verified country or Americana option to recommend in Austin for Oct 2 to 3.');
      expect(second!.text.split('\n\n')[1]).toBe('I don’t have a verified country or Americana option to recommend in Austin for Sat, Oct 3.');
      for (const r of [first!, second!]) {
        expect(r.text).not.toMatch(LATER);
        expect(r.text).not.toContain('Late Static'); // no rock in place of country
        expect(r.text).toMatch(/I checked the listings I have on file for country, Americana and bluegrass in Austin for (?:Oct 2 to 3|Sat, Oct 3)\. That’s what they show, not proof that nothing suitable is on\./);
        expect(r.text).not.toMatch(/budget (?:is )?met|within your budget|under \$150/);
      }
      expect(second!.text).toContain('Your limit is still $150 total for two, including fees.');
    });
    it('control: when they say later dates are fine, the next ones are shown, said as such', async () => {
      const [r] = await converse(['Country music in Austin on Saturday October 3, 2026, two of us, $150 total. Later dates are fine too.']);
      expect(r!.text).toContain('Country in Austin: nothing on Sat, Oct 3, but here are the next ones after that:');
      expect(r!.text).toContain('Kacey Musgraves - Middle of Nowhere Tour');
    });
  });

  describe('NW-02 and R1-DISCOVERY-CLOSURE-01: Los Angeles, no Orange County', () => {
    it('the opening offers the one or two asked for, a short status, what is unchecked, and the checks by name', async () => {
      const [first] = await converse([LA[0]!]);
      const parts = first!.text.split('\n\n');
      expect(parts[1]).toBe('I haven’t verified a match for your dates and budget yet.');
      expect(first!.html).toContain('<strong>I haven’t verified a match for your dates and budget yet.</strong>');
      expect(first!.text).toContain('Not checked yet for any of these: reserved seats, not general admission; 2 seats together; and $300 in total for both, once fees are added.');
      expect(first!.text).toContain('Pop in Los Angeles, Oct 9 to 10: two I can check for you.');
      expect((first!.text.match(/^• /gm) ?? []).length).toBe(2);
      expect(first!.text).not.toMatch(/Lilyisthatyou|Constellation Room|Reply "more"/);
      // "Tell me which you'd choose": answered from what's listed, without inventing a reason.
      expect(first!.text).toContain('On what’s listed they’re equally close, so the checks will decide between them.');
      expect(first!.text).toContain('Tell me which one, and I’ll check reserved seating, seats together and the all-in total.');
      expect(first!.text).not.toContain('check it against those');
    });
    it('the correction rules the venue and Orange County out, keeps Saturday, and answers each status', async () => {
      const [, second] = await converse(LA);
      expect(second!.text).toContain('I\'ve left out Constellation Room and Orange County.');
      expect(second!.text).toContain('Rachel Bochner');
      expect(second!.text).toContain('Sat, Oct 10');
      expect(second!.text).not.toMatch(/Lilyisthatyou|at Constellation Room|for KING & COUNTRY|Parrotfish|Fri, Oct 9|Want that one instead/);
      expect(second!.text).toContain('Not checked yet: reserved seats, not general admission; 2 seats together; and $300 in total for both, once fees are added.');
    });
    it('control: the same venue asked for, with its city, is searched', async () => {
      const [r] = await converse(['Pop concert at Constellation Room in Santa Ana on Friday October 9, 2026. Santa Ana is fine. Two tickets.']);
      expect(r!.text).toContain('Lilyisthatyou');
    });
  });

  describe('R2-EMAIL-POLICY-01: the late-entry reply names the night, and checks the other night for the music', () => {
    it('another house night that Saturday is named; the link says which night and room', async () => {
      const [, second] = await converse(['Dusky at Elsewhere in Brooklyn on Friday Oct 2. Two tickets. We won’t get there until midnight. Is that OK?', 'Is midnight entry verified? And did you check Saturday Oct 3 too?']);
      expect(second!.text).toContain('Here’s the event page for Dusky - 21+ at Elsewhere, Fri, Oct 2 at 10:30pm:');
      expect(second!.text).toContain('I checked Sat, Oct 3 too: no Dusky that night, but there’s Night Shift: Deep House at Brooklyn Basement, Sat, Oct 3 at 11pm, also listed as house.');
      expect(second!.text).toContain('Nothing I have states Elsewhere’s last entry for that night.');
    });
  });

  describe('eventConstraints: a venue correction is an exclusion, an allowed venue is not', () => {
    const ctx = { receivedAt: NOW, timeZone: 'America/Los_Angeles', venues: [{ name: 'Constellation Room', aliases: [] }] };
    it.each([
      ['Constellation Room is in Santa Ana, not Los Angeles. No Orange County please.'],
      ['Constellation Room isn’t in LA.'],
      ['The Constellation Room is actually in Santa Ana, not LA, so skip it.'],
    ])('%s → excluded', (text) => {
      const c = eventConstraints([text], ctx);
      expect(c.excludedVenues).toEqual(['constellation room']);
      expect(c.venueTerms).toBeNull();
    });
    it.each([
      ['Constellation Room is in Santa Ana, which is fine.'],
      ['Concert at Constellation Room on Saturday.'],
    ])('%s → asked for', (text) => {
      const c = eventConstraints([text], ctx);
      expect(c.excludedVenues).toEqual([]);
      expect(c.venueTerms).toEqual(['constellation room']);
    });
  });
});
