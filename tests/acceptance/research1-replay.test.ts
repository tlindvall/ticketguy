import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv, makeConcierge } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { R1, seedR1 } from './r1-research.harness';

/**
 * Research 1 (structured testing, prepared Sep 30 2026): the response rules for the trusted ticket guy, as
 * acceptance criteria. Eight cases: the three historical two-turn regressions (Austin, Brooklyn, LA), three local
 * controls (permission to broaden, a latest-entry time independent of the start, a venue named for vs against) and
 * the two supplied-quote decisions (R1-04 preference, R1-05 no fit then an explicit relaxation).
 *
 * The case texts are reconstructed from the Research 1 brief; TEST_CASES.json wasn't available here. The catalog is
 * synthetic and fixed in time (clock Sep 30 2026), so the historical dates replay as written; nothing here claims
 * live availability, entry terms or prices. These are rules-path results, not proof of the production model.
 */
const NOW = new Date('2026-09-30T16:00:00Z');

describe('Research 1: useful advice and email responses', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; html: string; cls: string; state: string; eventId: string | null };
  const converse = async (turns: string[], env = testEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'r1-allow@customer.example' })): Promise<Turn[]> => {
    const c = makeConcierge(h, { env, now: () => NOW });
    n += 1;
    const from = `r1-${n}@customer.example`;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const text of turns) {
      const m = inbound({ text, from, subject: prev ? 'Re: Tickets' : 'Tickets', inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let i = 0; i < 6; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: NOW });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
        }
      }
      const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
      const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
      const last = sends.at(-1)!;
      out.push({ text: last.bodyText.split('\nTicket Guy\n')[0]!, html: last.bodyHtml, cls: last.messageClass, state: req!.state, eventId: req!.eventId });
    }
    return out;
  };
  // Rules 7 and 10: a few meaningful bold phrases, one next step, and the residency line only on a first reply.
  const writing = (r: Turn, opts: { first: boolean }) => {
    expect((r.html.match(/<strong>/g) ?? []).length).toBeLessThanOrEqual(3);
    expect((r.text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
    if (!opts.first) expect(r.text).not.toContain('Ticket Guy is for US-based fans');
    expect(r.text).not.toMatch(/Want me to compare\?.*\n.*Reply "more"/s);
  };

  beforeAll(async () => {
    h = await openTestDb();
    await seedR1(h);
  });
  afterAll(async () => {
    await h.close();
  });

  describe('historical regressions (two turns each)', () => {
    it('Austin (NW-03): both dates read, then a useful no on Saturday that keeps the genre, the budget and one next step', async () => {
      const [first, second] = await converse([
        'Any good country or Americana shows in Austin on Friday Oct 9 or Saturday Oct 10, 2026? Two of us, $150 total including fees. Which one would you pick for us?',
        'I asked for country or Americana, not rock or pop. Saturday Oct 10 works best. Still two of us, $150 total including fees.',
      ]);
      // Opening: Austin, not the default city; both dates looked at; only the country show offered.
      expect(first!.text).toContain('the only country show I found in Austin for Oct 9 to 10');
      expect(first!.text).toContain('Prairie Lanterns');
      expect(first!.text).not.toMatch(/Voltage Saints|Glitter Theory|Neon Pulse|New York/);
      expect(first!.text).toContain('$150 in total for both');
      // Correction: no rejected genres, the answer first, coverage stated honestly, budget kept, one productive step.
      expect(second!.text.split('\n\n')[1]).toBe('I don’t have a verified country or Americana option to recommend in Austin for Sat, Oct 10.');
      expect(second!.html).toContain('<strong>I don’t have a verified country or Americana option to recommend in Austin for Sat, Oct 10.</strong>');
      expect(second!.text).toContain('Your limit is still $150 total for two, including fees.');
      expect(second!.text).toContain('not proof that nothing suitable is on');
      expect(second!.text).not.toMatch(/Voltage Saints|Glitter Theory|Neon Pulse|nothing on in Austin/);
      expect(second!.text).toContain('Prairie Lanterns at Broken Spoke on Fri, Oct 9. Want that one instead?');
      writing(second!, { first: false });
    });

    it('Brooklyn (NW-01): midnight entry answered first, before any seller; the Saturday question answered, Friday kept', async () => {
      const [first, second] = await converse([
        'Dusky at Elsewhere in Brooklyn on Friday Oct 2. Two tickets. We won’t get there until midnight. Is that OK, and is it worth it?',
        'You didn’t answer: is midnight entry verified? And did you check Saturday Oct 3 too?',
      ]);
      for (const r of [first!, second!]) {
        expect(r.text.split('\n\n')[1]).toMatch(/^Midnight entry is unverified\. The 10:30pm start on the listing doesn’t tell us the latest entry time/);
        expect(r.html).toContain('<strong>Midnight entry is unverified.</strong>');
        expect(r.text).not.toMatch(/that's where I'd buy|where I’d buy|Want me to compare/);
        expect(r.text).toContain('https://www.ticketmaster.com/event/Z7r9jZ1A7PU4M');
        expect(r.text).toContain('Treat it as a candidate until its late-entry policy is confirmed.');
        expect(r.text).toContain('Before buying, confirm that this event admits people arriving at midnight.');
        expect(r.eventId).toBe(R1.e.dusky);
      }
      expect(second!.text).toContain('You’re right that my last reply should have said that first.');
      // The other night is checked for the kind of music, not only the act, and the link names night and room
      // (Research 2 link/email review, R2-EMAIL-POLICY-01).
      expect(second!.text).toContain('I checked Sat, Oct 3 too: I don’t have Dusky or another house night in Brooklyn on file then');
      expect(second!.text).toContain('Here’s the listing for Dusky at Elsewhere, Fri, Oct 2 at 10:30pm:');
      expect(second!.text).toContain('Nothing I have states Elsewhere’s last entry for that night.');
      expect(second!.text).not.toMatch(/own page or box office/);
      writing(second!, { first: false });
    });

    it('LA (NW-02, NW-04): the city, not Orange County; requirements named as unchecked; the correction keeps them', async () => {
      const [first, second] = await converse([
        'Looking for a concert in Los Angeles on Saturday October 10, 2026. Two reserved seats together, $300 total for both including fees. What would you pick?',
        'Not Constellation Room, that’s Santa Ana, not LA. I need Los Angeles on Saturday Oct 10, reserved seats together, $300 total for two.',
      ]);
      for (const r of [first!, second!]) {
        expect(r.text).not.toMatch(/Constellation Room|Santa Ana|Paper Coast/);
        expect(r.text).not.toContain('Velvet Hours'); // Friday's show is not a Saturday answer
        expect(r.text).toContain('Harbor Lights at The Wiltern');
        expect(r.text).toContain('Canyon Choir at Greek Theatre');
        // A candidate is not a suitable offer: what isn't established, said before the list, not "my picks".
        // One short status in bold, the requirements named after it, and the checks named in the next step
        // (Research 2 link/email review, R2-EMAIL-HIERARCHY-01).
        expect(r.text.split('\n\n')[1]).toBe('I haven’t verified a match for your dates and budget yet.');
        expect(r.text).toContain('Not checked yet for any of these: reserved seats, not general admission; 2 seats together; and $300 in total for both, once fees are added.');
        expect(r.text).not.toMatch(/my (?:two|three) picks/);
        expect(r.text).toContain('Tell me which one, and I’ll check reserved seating, seats together and the all-in total.');
      }
      writing(first!, { first: true });
      writing(second!, { first: false });
    });
  });

  describe('local controls', () => {
    it('genres widen only with permission, and say so', async () => {
      const [r] = await converse(['Any country shows in Austin on Saturday Oct 10, 2026? Two of us, $150 total including fees. Country preferred but anything else is fine.']);
      expect(r!.text).toContain('I don’t have a country show in Austin for Sat, Oct 10, so since you said anything else is fine, here’s what is on.');
      expect(r!.text).toMatch(/Voltage Saints|Glitter Theory|Neon Pulse/);
      const [strict] = await converse(['Any country shows in Austin on Saturday Oct 10, 2026? Two of us, $150 total including fees.']);
      expect(strict!.text).not.toMatch(/Voltage Saints|Glitter Theory|Neon Pulse/);
    });

    it('a quoted latest-entry time decides it, independently of the start time', async () => {
      const [, ok] = await converse(['Dusky at Elsewhere in Brooklyn on Friday Oct 2. Two tickets. We won’t get there until midnight. Is that OK?', 'The venue page says last entry is 1am.']);
      expect(ok!.text).toContain('Midnight entry fits the terms you quoted. You quoted last entry by 1am, so arriving at midnight works on that basis. I haven’t checked those terms myself');
      expect(ok!.text).not.toContain('candidate until');
      const [no] = await converse(['Dusky at Elsewhere in Brooklyn on Friday Oct 2. Two tickets. We won’t get there until midnight. The page says entry before 11:30pm. Can we use it?']);
      expect(no!.text).toContain('Midnight entry doesn’t fit the terms you quoted. You quoted entry before 11:30pm, and you’d arrive at midnight');
      expect(no!.text).toContain('Look for a ticket type that allows entry at midnight, or plan to arrive before 11:30pm.');
    });

    it('a venue named for the search places it; a venue ruled out never becomes the destination', async () => {
      const [at] = await converse(['Concert at Constellation Room on Saturday October 10, 2026, two tickets.']);
      expect(at!.text).toContain('Paper Coast');
      expect(at!.text).toContain('Constellation Room');
      const [, not] = await converse(['Looking for a concert in Los Angeles on Saturday October 10, 2026, two tickets.', 'Not Constellation Room, that’s Santa Ana, not LA.']);
      expect(not!.text).not.toMatch(/Constellation Room|Paper Coast/);
    });
  });

  describe('supplied-fact decisions (hypothetical quotes, never verified inventory)', () => {
    const quotes = 'Two of us for a concert. Two adjacent reserved seats either way. Offer A: upper tier, $240 total including fees. Offer B: lower tier, $285 total including fees. Our cap is $300 total.';
    it('R1-04: the stated priority changes the pick, and the reason names it', async () => {
      const [price] = await converse([`${quotes} Keeping the spend down matters most to us. Which should we choose?`]);
      expect(price!.text).toContain('I’d take A for you: $240 for both, fees included. It leaves $60 under your $300 cap. Offer B costs $45 more for the lower tier; since keeping the spend down matters most to you, I wouldn’t pay that difference on the facts you’ve supplied.');
      expect(price!.html).toContain('<strong>I’d take A for you: $240 for both, fees included.</strong>');
      const [tier] = await converse([`${quotes} Being in the lower tier matters most to us. Which should we choose?`]);
      expect(tier!.text).toContain('I’d take B for you: $285 for both, fees included. It costs $45 more than Offer A, and since the lower tier is what matters most to you, that’s the difference worth paying.');
      for (const r of [price!, tier!]) {
        expect(r.text).toContain('That’s based on your quotes; I haven’t verified availability or the view.');
        expect(r.text).not.toMatch(/admission unverified|Admission entitlement is unknown/);
      }
      expect(tier!.text).toContain('Offer A (ordinary seats, upper tier): $240 in total including fees. Also fits, $45 less.');
    });

    it('R1-05: no offer fits, the one change that would make one work is named, and a later relaxation is applied to the same offers', async () => {
      const [none, relaxed] = await converse([
        'Two of us for a concert, we need two adjacent reserved seats. Offer A: two seats in different rows, $220 total including fees. Offer B: two adjacent reserved seats, $340 total including fees. Our cap is $300 total. Which should we choose?',
        'We could stretch to $350 total if that’s what it takes for seats together.',
      ]);
      expect(none!.text).toContain('None of the two meets all your requirements. The smallest change: if you can stretch to $340 in total, Offer B meets everything else.');
      expect(none!.text).toContain('The seats aren’t together.');
      expect(none!.text).toContain('Over your $300 budget by $40.');
      expect(relaxed!.text).toContain('Offer B is the one that meets what you asked for: $340 for both, fees included. It leaves $10 of your $350 budget.');
      expect(relaxed!.text).not.toMatch(/Dusky|general sale|New York/);
    });
  });
});
