import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { concertBudget } from '@/lib/advice/concert-terms';
import { eventConstraints, excludedPlaces } from '@/lib/domain/event-constraints';
import { ageBlock, listedMinimumAge, partyMinimumAge, ruledOutAgeFloor, withoutAgeTag } from '@/lib/domain/age';
import { readableTitle } from '@/lib/domain/browse';
import { seedDiscovery } from './r1-discovery.harness';

/**
 * Research2 discovery and link retest (Oct 1 2026, build a80744b): the exact two-turn texts for Los Angeles (C01),
 * Brooklyn (C02) and Nashville (C03), through the real intake and reply path, over the Research 1 catalog plus
 * synthetic Nashville and Franklin rooms. Rules-path extraction, not the production model.
 */
const NOW = new Date('2026-10-01T23:30:00Z');
const C01 = [
  'Two adults want a mainstream pop concert in Los Angeles on Friday October 9 or Saturday October 10, 2026. Los Angeles only, not Anaheim or Santa Ana. Two reserved seats together, $300 TOTAL including fees. Give one or two official event links and tell me which you would choose. Separate what is verified about seats, adjacency and the total from what is unknown.',
  'Skip Constellation Room and Orange County entirely. Saturday October 10 only now. Keep two reserved seats together and $300 total including fees. Which option would you choose, and are reserved seats, seats together and the all-in total verified?',
];
const C02 = [
  'House or minimal techno in Brooklyn on Friday October 2 or Saturday October 3, 2026. Prefer Elsewhere or Nowadays, but another Brooklyn venue is fine. I am 24 and my friend is 20, so no 21+ nights. We arrive at midnight. Two tickets, $120 TOTAL including fees. Give one or two usable official options and tell me which you would choose. Do not assume age eligibility or midnight entry.',
  'Saturday October 3 only. We still cannot go to a 21+ event and arrive at midnight. Keep Brooklyn, two tickets and $120 total. Which event could work, and what have you verified about minimum age, late entry and total price? Give the relevant official source beside each fact, or say it is unknown.',
];
const C03 = [
  'Six adults want country or Americana in Nashville, Tennessee, on Friday October 2 or Saturday October 3, 2026. Nashville only, not Franklin. Six seats together, $600 TOTAL including fees. No cover bands or country-themed bars. Give one or two original artist events, official links, and which you would choose for us.',
  'Saturday October 3 only now. No Franklin or events outside Nashville. Keep six seats together and $600 total including fees. Which option would you choose? Are the artist, venue, reserved seats, six together and all-in total verified, or not yet checked?',
];

describe('Research2 retest: age, exclusions, preferences, budget and the decision', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; html: string; brief: Record<string, unknown> };
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const [i, text] of turns.entries()) {
      const m = inbound({ text, from: `r2rt-${n}@customer.example`, subject: prev ? 'Re: Concert' : 'Concert', receivedAt: new Date(NOW.getTime() + i * 1000), inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let j = 0; j < 6; j++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: new Date(NOW.getTime() + 10_000) });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
        }
      }
      const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
      const versions = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId));
      out.push({ text: sends.at(-1)!.bodyText.split('\nTicket Guy\n')[0]!, html: sends.at(-1)!.bodyHtml, brief: versions.at(-1)!.brief as Record<string, unknown> });
    }
    return out;
  };
  const bullets = (x: Turn) => (x.text.match(/^• /gm) ?? []).length;

  beforeAll(async () => {
    h = await openTestDb();
    await seedDiscovery(h);
    const ids: string[] = [];
    for (const v of [
      { name: 'QA Nashville Room', city: 'Nashville', latitude: 36.1627, longitude: -86.7816 },
      { name: 'QA Franklin Room', city: 'Franklin', latitude: 35.9251, longitude: -86.8689 },
    ]) ids.push((await h.db.insert(t.venues).values({ ...v, state: 'TN', country: 'US', timezone: 'America/Chicago' }).returning())[0]!.id);
    const rows: Array<[string, string, string, string]> = [
      ['QA Nashville Country', 'country / country', ids[0]!, '2026-10-03T01:00:00Z'],
      ['QA Nashville Americana', 'country / americana', ids[0]!, '2026-10-04T01:00:00Z'],
      ['QA Franklin Country', 'country / country', ids[1]!, '2026-10-04T01:00:00Z'],
      ['QA Country Tribute Night', 'country / country', ids[0]!, '2026-10-03T02:30:00Z'],
    ];
    for (const [i, [name, genre, venueId, start]] of rows.entries()) {
      const [e] = await h.db.insert(t.events).values({ name, genre, venueId, category: 'concert', localStartAt: new Date(start), status: 'scheduled', isFixture: true, verifiedSourceId: 'ticketmaster' }).returning();
      await h.db.insert(t.eventSourceMappings).values({ eventId: e!.id, sourceId: 'ticketmaster', sourceEventId: `R2RT${i}`, authoritativeUrl: `https://www.ticketmaster.com/event/R2RT${i}`, role: 'discovery', confidence: 'provider_id' });
    }
  });
  afterAll(async () => {
    await h.close();
  });

  describe('C01 Los Angeles: skip stays an exclusion, and the $300 cap is kept', () => {
    it('both turns save two tickets and a $300 whole-party cap', async () => {
      const turns = await converse(C01);
      for (const x of turns) expect(x.brief).toMatchObject({ quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party', togetherRequired: true });
    });
    it('the opening gives no more than the two asked for, answers the choice, and invents no seat facts', async () => {
      const [first] = await converse([C01[0]!]);
      expect(bullets(first!)).toBe(2);
      expect(first!.text).toContain('Not checked yet for any of these: reserved seats, not general admission; 2 seats together; and $300 in total for both, once fees are added.');
      expect(first!.text).toMatch(/On what’s listed they’re equally close|My tentative pick is/);
      expect(first!.text).not.toMatch(/Constellation Room|Santa Ana|Anaheim|Reply "more"|three I can check/);
      expect(first!.text).not.toMatch(/\b(?:verified|confirmed) (?:reserved|adjacent|together|total)/i);
    });
    it('the follow-up leads with the exclusion and what is kept, and never searches the skipped venue', async () => {
      const [, second] = await converse(C01);
      expect(second!.text.split('\n\n')[1]).toBe('Constellation Room and Orange County are excluded. We’re keeping Saturday, two together and your $300 total cap.');
      expect(second!.html).toContain('<strong>Constellation Room and Orange County are excluded. We’re keeping Saturday, two together and your $300 total cap.</strong>');
      expect(second!.text).toContain('Rachel Bochner');
      expect(second!.text).not.toMatch(/at Constellation Room|Lilyisthatyou|Fri, Oct 9/);
      expect(second!.text).toContain('Not checked yet: reserved seats, not general admission; 2 seats together; and $300 in total for both');
    });
    it.each(['Leave out Constellation Room.', 'Don’t include Constellation Room.', 'Avoid Constellation Room.', 'No Constellation Room.', 'Skipping Constellation Room.'])('"%s" is an exclusion, kept across turns', (said) => {
      const rules = eventConstraints([C01[0]!, said, 'Saturday October 10 only now.'], { receivedAt: NOW, timeZone: 'America/Los_Angeles', venues: [{ name: 'Constellation Room', aliases: [] }] });
      expect(rules.excludedVenues).toContain('constellation room');
      expect(rules.venueTerms).toBeNull();
    });
    it('a venue they ask for is still asked for', () => {
      const rules = eventConstraints(['Concert at Constellation Room on Saturday October 10, 2026, two tickets.'], { receivedAt: NOW, timeZone: 'America/Los_Angeles', venues: [{ name: 'Constellation Room', aliases: [] }] });
      expect(rules.venueTerms).toEqual(['constellation room']);
      expect(rules.excludedVenues).toEqual([]);
    });
  });

  describe('C02 Brooklyn: a known 21+ listing is out for a 20-year-old; Elsewhere is a preference', () => {
    it('the opening rules Dusky out by name and age before any late-entry answer, and offers another Brooklyn venue', async () => {
      const [first] = await converse([C02[0]!]);
      const parts = first!.text.split('\n\n');
      expect(parts[1]).toBe('Dusky is out: it’s listed as 21+, and your friend is 20.');
      expect(first!.html).toContain('<strong>Dusky is out: it’s listed as 21+, and your friend is 20.</strong>');
      expect(first!.text).not.toContain('D000105');
      expect(first!.text).not.toMatch(/listing for Dusky|Dusky - 21\+ at Elsewhere/);
      expect(first!.text).toContain('Here’s the listing for Night Shift: Deep House at Brooklyn Basement, Sat, Oct 3 at 11pm');
      expect(first!.text).toContain('Midnight entry is unverified.');
      expect(first!.text).toContain('Minimum age is unknown: the listing doesn’t state one, and nothing I have does. Confirm it admits a 20-year-old before buying.');
      expect(first!.brief).toMatchObject({ quantity: 2, budgetCents: 12000, budgetBasis: 'whole_party' });
    });
    it('the follow-up keeps Saturday, Brooklyn and the age rule, and says what is unknown', async () => {
      const [, second] = await converse(C02);
      expect(second!.text).not.toMatch(/Dusky|D000105|at Elsewhere for Sat/);
      expect(second!.text).toContain('Night Shift: Deep House at Brooklyn Basement, Sat, Oct 3');
      expect(second!.text).toContain('Midnight entry is unverified.');
      expect(second!.text).toContain('Minimum age is unknown');
      expect(second!.brief).toMatchObject({ quantity: 2, budgetCents: 12000 });
    });
    it('control: a group of 24-year-olds may still see the 21+ night', async () => {
      const [first] = await converse(['Two adults age 24 want house or minimal techno in Brooklyn on Friday October 2 or Saturday October 3, 2026. Under $120 TOTAL including fees. Give one or two official listings and which you would choose.']);
      expect(first!.text).toContain('Dusky - 21+ at Elsewhere');
      expect(first!.text).not.toContain('is out:');
    });
    it('control: "Elsewhere only" stays a hard venue', async () => {
      const [first] = await converse(['House or minimal techno in Brooklyn on Friday October 2 or Saturday October 3, 2026. Elsewhere only. Two adults, both 24, two tickets.']);
      expect(first!.text).toContain('Dusky');
      expect(first!.text).not.toContain('Night Shift');
    });
    it('a named 21+ event is out before late entry is discussed, with no link', async () => {
      const [first] = await converse(['Dusky at Elsewhere in Brooklyn on Friday October 2, 2026. Two tickets. I am 24 and my friend is 20. We arrive at midnight.']);
      expect(first!.text.split('\n\n')[1]).toBe('Dusky is out: it’s listed as 21+, and your friend is 20.');
      expect(first!.text).not.toMatch(/Midnight entry|ticketmaster\.com|\/go\//);
    });
    it('ages are read only from what is said; a listing without an age is unknown', () => {
      const c02 = C02[0]!;
      expect(partyMinimumAge(c02)).toEqual({ age: 20, who: 'your friend' });
      expect(ruledOutAgeFloor(c02)).toBe(21);
      expect(ruledOutAgeFloor(C02[1]!)).toBe(21);
      expect(partyMinimumAge('Two tickets, 24 seats, doors at 10pm')).toBeNull();
      expect(partyMinimumAge('We’re 10 friends going, I’m 30 minutes away')).toBeNull();
      expect(partyMinimumAge('ages 24 and 20')).toMatchObject({ age: 20 });
      expect(listedMinimumAge('Dusky - 21+')).toBe(21);
      expect(listedMinimumAge('Fox N’ Vead (18 and Over)')).toBe(18);
      expect(listedMinimumAge('Night Shift: Deep House')).toBeNull();
      expect(listedMinimumAge('Elsewhere Rooftop')).toBeNull();
      expect(ageBlock('Dusky - 21+', 'Two adults age 24')).toBeNull();
      expect(ageBlock('Night Shift: Deep House', c02)).toBeNull();
      expect(ageBlock('Dusky - 21+', c02)).toEqual({ listed: 21, reason: 'your friend is 20' });
      expect(withoutAgeTag('Dusky - 21+')).toBe('Dusky');
    });
    it('a soft preference ranks; it never filters', () => {
      const rules = eventConstraints([C02[0]!], { receivedAt: NOW, timeZone: 'America/New_York', venues: [{ name: 'Elsewhere', aliases: [] }, { name: 'Nowadays', aliases: [] }] });
      expect(rules.venueTerms).toBeNull();
      expect(rules.preferredVenues).toEqual(expect.arrayContaining(['elsewhere', 'nowadays']));
    });
  });

  describe('C03 Nashville: an excluded town stays out inside the metro', () => {
    it('neither turn offers Franklin, and the follow-up says so first', async () => {
      const [first, second] = await converse(C03);
      for (const x of [first!, second!]) {
        expect(x.text).not.toMatch(/QA Franklin|R2RT2|Tribute/);
        expect(x.brief).toMatchObject({ quantity: 6, budgetCents: 60000, budgetBasis: 'whole_party' });
      }
      expect(bullets(first!)).toBeLessThanOrEqual(2);
      expect(first!.text).toMatch(/On what’s listed they’re equally close|My tentative pick is/);
      expect(second!.text.split('\n\n')[1]).toBe('Franklin is excluded. We’re keeping Saturday, six together and your $600 total cap.');
      expect(second!.text).toContain('QA Nashville Americana');
    });
    it('control: Franklin allowed is offered', async () => {
      const [first] = await converse(['Six adults want country or Americana in Nashville, Tennessee, on Saturday October 3, 2026. Franklin is fine too. Six seats together, $600 TOTAL including fees. Give one or two options.']);
      expect(first!.text).toContain('QA Franklin Country');
    });
    it('excluded places are read from capitalised names, not sentences', () => {
      expect(excludedPlaces([C03[0]!])).toContain('franklin');
      expect(excludedPlaces([C03[1]!])).toContain('franklin');
      expect(excludedPlaces([C01[0]!])).toEqual(expect.arrayContaining(['anaheim', 'santa ana']));
      expect(excludedPlaces(['Not checked yet, no rush.'])).toEqual([]);
    });
  });

  describe('budget, count and wording', () => {
    it('a party cap is kept; a quoted price is not a cap', () => {
      expect(concertBudget(C01[0]!)).toEqual({ cents: 30000, basis: 'whole_party' });
      expect(concertBudget(C01[1]!)).toEqual({ cents: 30000, basis: 'whole_party' });
      expect(concertBudget(C03[0]!)).toEqual({ cents: 60000, basis: 'whole_party' });
      expect(concertBudget('Pop concert in LA. The listing I saw is $250 total including fees for two.')).toBeNull();
      expect(concertBudget('Pop concert in LA. The seller quoted $250 total including fees.')).toBeNull();
      expect(concertBudget('Pop concert. Budget $200 total for both.')).toEqual({ cents: 20000, basis: 'whole_party' });
    });
    it('long bills read as names', () => {
      expect(readableTitle('Dead Man\'s Party (Tribute to Oingo Boingo + Danny Elfman), Echoes of Pompeii (Pink Floyd Tribute)')).toBe('Dead Man\'s Party and Echoes of Pompeii (tribute acts)');
      expect(readableTitle('NIGHT SHIFT : DEEP HOUSE')).toBe('Night Shift: Deep House');
      expect(readableTitle('for KING & COUNTRY')).toBe('for KING & COUNTRY');
    });
  });
});
