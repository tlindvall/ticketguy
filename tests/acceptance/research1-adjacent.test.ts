import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { isFoodDrink } from '@/lib/domain/service-depth';
import { suppliedEvidenceAnswer } from '@/lib/advice/supplied-evidence';

/**
 * Research 1 adjacent-event decision QA (Oct 1 2026): a cover and a minimum at a comedy club, a Broadway lottery
 * against a sure pair, and a toddler's admission to a family show. Each is a decision the customer can make
 * without a catalog match, and each was answered with event intake or the wrong template (R1-A01 to R1-A05).
 *
 * Texts are rebuilt from the report; EXECUTED_PLAN.json wasn't available here. The rules supplied in the controls
 * are the customer's words, said back as theirs; nothing here is a live policy check, stock or a purchase.
 */
const COMEDY = 'Two of us are going to the Comedy Cellar in New York on Saturday. The cover is $24 each, food and drink are extra, and our whole-night cap is $100. Does $48 cover the night? Do we have to drink alcohol?';
const COMEDY_PRICED = 'Keep the $24 cover and $100 total cap. We will add exactly two $9 qualifying items each, with all item charges and tips included. What is the total?';
const COMEDY_RULE = 'Two of us are going to the Comedy Cellar in New York on Saturday. The cover is $24 each, food and drink are extra, and our whole-night cap is $100. The reservation policy (https://comedycellar.com/reservations/) says there is a two-item minimum per person, and food or non-alcoholic drinks count. Does $48 cover the night? Do we have to drink alcohol?';
const BROADWAY = 'We are in New York for one night only, Oct 10, and want two seats together for a Broadway show. We could enter the digital lottery for $50 tickets, buy a guaranteed adjacent pair for $220 total, or take a guaranteed $100 alternative. Our cap is $240 and we must sit together. Can we count the lottery as guaranteed tickets?';
const BROADWAY_WON = 'Update: we won the lottery. We still must sit together. Does that change your answer?';
const BROADWAY_TERMS = 'We are in New York for one night only, Oct 10, and want two seats together for a Broadway show. We could enter the digital lottery for $50 tickets or buy a guaranteed adjacent pair for $220 total. Our cap is $240 and we must sit together. The lottery terms (https://lottery.broadwaydirect.com/terms/) say winners get the opportunity to purchase tickets and adjacent seats are not guaranteed. Can we count the lottery as guaranteed tickets?';
const FAMILY = 'We want Disney On Ice in Seattle: two adults and our 23-month-old daughter. Do we buy two tickets or three?';
const FAMILY_OLDER = 'Correction: she will be 25 months old on the performance date.';
const FAMILY_FAQ = 'We want Disney On Ice in Seattle: two adults and our 23-month-old daughter. The FAQ (https://www.disneyonice.com/en-us/faq/) says children 2 and older need a ticket, children under 2 can sit on a lap, but some arenas require a ticket for every age. Do we buy two tickets or three?';

// What none of these replies may do: restart intake, take the food template, claim a check or stock, act for them.
const NEVER = /Food and drink festivals|Got it|Which event \(performer|on file for|I['’]ve looked|is available|in stock|I['’]ve entered|I entered|reserved for you|prices will|trend/i;

describe('Research 1: adjacent-event decisions', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; html: string; brief: Record<string, unknown>; policy: { category?: string } | null };
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => FIXTURE_NOW, env: testEnv({ SERVICE_POLICY_MODE: 'enforce' }) });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const text of turns) {
      const m = inbound({ text, from: `r1a-${n}@customer.example`, subject: prev ? 'Re: Tickets' : 'Tickets', inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let i = 0; i < 8; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
        }
      }
      const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId));
      expect(sends).toHaveLength(out.length + 1);
      const versions = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId));
      const last = sends.at(-1)!;
      out.push({ text: last.bodyText.split('\nTicket Guy\n')[0]!.trim(), html: last.bodyHtml, brief: versions.at(-1)!.brief as Record<string, unknown>, policy: versions.at(-1)!.servicePolicy as { category?: string } | null });
    }
    return out;
  };
  // The answer first and bold; one bold phrase; the one next step, when there is one, last.
  const answered = (r: Turn, lead: string) => {
    expect(r.text.split('\n\n')[0]).toBe(lead);
    const body = r.html.slice(r.html.indexOf('<p'), r.html.indexOf('Ticket Guy'));
    expect(body).toMatch(/^<p[^>]*><strong>/);
    expect((body.match(/<strong>/g) ?? []).length).toBe(1);
    expect(r.text).not.toMatch(NEVER);
  };

  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  describe('R1-A01/A03: a comedy club’s cover and minimum', () => {
    it('opening: $48 is entry, not the night; then the priced follow-up keeps the $100 cap: $84, $16 left', async () => {
      const [first, second] = await converse([COMEDY, COMEDY_PRICED]);
      answered(first!, '$48 covers entry for the two of you, not the whole night.');
      expect(first!.text).toContain('Whether there is one, and whether it has to be alcohol, is the venue’s rule');
      expect(first!.text).toContain('Send me the prices of what you’d order, with any charges and tip, and I’ll check the night against your $100 cap.');
      expect(first!.brief).toMatchObject({ categoryHint: 'comedy', budgetCents: 10000, quantity: 2 });
      expect(first!.policy?.category ?? null).not.toBe('food_drink');
      answered(second!, 'With your supplied prices, that’s $84 total, $16 under your cap.');
      expect(second!.text).toContain('$48 cover + four $9 items = $84.');
      expect(second!.text).toContain('That assumes the item prices include every charge and tip, as you said; they aren’t verified menu prices.');
      expect(second!.brief).toMatchObject({ budgetCents: 10000 });
    });
    it('supplied-rule control: the two-item rule, food or soft drinks count, and the link with its status', async () => {
      const [r] = await converse([COMEDY_RULE]);
      answered(r!, '$48 covers entry for the two of you, not the whole night.');
      expect(r!.text).toContain('The rule you supplied says two qualifying items per person, and food or non-alcoholic drinks count, so it isn’t a requirement to drink alcohol.');
      expect(r!.html).toContain('<a href="https://comedycellar.com/reservations/">');
      expect(r!.text).toContain('I haven’t checked it myself in this reply.');
    });
  });

  describe('R1-A02/A05: a lottery is not a plan', () => {
    it('opening: not guaranteed; the adjacent pair fits at $220 with $20 left; then winning still doesn’t settle seats together', async () => {
      const [first, second] = await converse([BROADWAY, BROADWAY_WON]);
      answered(first!, 'I wouldn’t count the lottery as your guaranteed plan.');
      expect(first!.text).toContain('Before the draw, a lottery is a chance to buy, not a ticket.');
      expect(first!.text).toContain('meets your sit-together requirement at $220 total, leaving $20 of your $240. For a one-night visit, that’s the safer plan.');
      expect(first!.brief.genreHint ?? null).toBeNull();
      answered(second!, 'Winning lets you buy, but I can’t tell from what you’ve sent whether those seats would be together.');
      expect(second!.text).toContain('only the plan if the seller confirms they’re together');
      expect(second!.text).toContain('$220 total, leaving $20 of your $240');
    });
    it('supplied-terms control: adjacent seats aren’t guaranteed even if you win, with the terms linked', async () => {
      const [r] = await converse([BROADWAY_TERMS]);
      answered(r!, 'I wouldn’t count the lottery as your guaranteed plan.');
      expect(r!.text).toContain('The terms you supplied also say adjacent seats aren’t guaranteed even if you win.');
      expect(r!.html).toContain('<a href="https://lottery.broadwaydirect.com/terms/">');
      expect(r!.text).toContain('I haven’t checked them myself in this reply.');
    });
  });

  describe('R1-A02/A04: a toddler’s admission', () => {
    it('opening: at 23 months it depends on the arena, asked once; at 25 months, three admissions', async () => {
      const [first, second] = await converse([FAMILY, FAMILY_OLDER]);
      answered(first!, 'At 23 months, many family shows let a child sit on a lap without a ticket, but the arena’s rule decides.');
      expect(first!.text).toContain('If a lap is allowed, two tickets cover your family; if the arena requires one at every age, you need three.');
      expect(first!.text).toContain('Which arena and performance are you looking at? That settles it.');
      expect(first!.brief).toMatchObject({ quantity: null, city: 'Seattle', eventName: 'Disney On Ice' });
      answered(second!, 'At 25 months, most family shows require a child’s own ticket: three admissions for your family.');
      expect(second!.text).toContain('it doesn’t mean a child discount');
      expect(second!.text).not.toMatch(/free|discount(?:ed)? ticket/i);
      expect(second!.brief).toMatchObject({ quantity: 3, eventName: 'Disney On Ice' });
    });
    it('supplied-FAQ control: the general rule with the arena exception, linked', async () => {
      const [r] = await converse([FAMILY_FAQ]);
      answered(r!, 'At 23 months, the general rule you supplied may allow a lap child, but the arena can require a ticket at every age.');
      expect(r!.html).toContain('<a href="https://www.disneyonice.com/en-us/faq/">');
    });
  });

  describe('paired intake controls: the bug cases change, the working cases stay', () => {
    const x = new FixtureExtractor();
    const base = { messageId: 'm1', subject: null, receivedAt: FIXTURE_NOW, venueTimeZone: 'America/New_York', knownEntities: [] };
    it('R1-A01: comedy with extras is not a food festival; a real food or wine festival still is', () => {
      expect(isFoodDrink(COMEDY)).toBe(false);
      expect(isFoodDrink('Two tickets to the Brooklyn Wine Festival on Saturday')).toBe(true);
      expect(isFoodDrink('Is the NYC Food and Wine Festival worth it?')).toBe(true);
    });
    it('R1-A03: "$100 total cap" is the cap whatever comes first; "our total budget is $100" still parses', async () => {
      expect(await x.extract({ ...base, text: COMEDY_PRICED })).toMatchObject({ budgetCents: 10000, budgetBasis: 'whole_party' });
      expect(await x.extract({ ...base, text: 'We will add two $9 items each. Our total budget is $100.' })).toMatchObject({ budgetCents: 10000 });
      expect(await x.extract({ ...base, text: 'two tickets, $300 total' })).toMatchObject({ budgetCents: 30000 });
    });
    it('R1-A04: "two tickets or three?" is an open choice; "we need three tickets" is three', async () => {
      const open = await x.extract({ ...base, text: FAMILY });
      expect(open.quantity).toBeNull();
      expect(open.ambiguities).toContain('quantity_unclear');
      expect(await x.extract({ ...base, text: 'We need three tickets for Disney On Ice in Seattle.' })).toMatchObject({ quantity: 3 });
    });
    it('options side by side are not a price change: the Research 2 route leaves the Broadway question alone', () => {
      // It read "$50 tickets" as a 50-seat group and "$50 … $220" as a rise (found in this wave; see the PR).
      expect(suppliedEvidenceAnswer([BROADWAY])).toBeNull();
      expect(suppliedEvidenceAnswer(['Yesterday single tickets were $90 each and today they are $60. Did they get cheaper?'])?.lead).toBe('Singles fell $30, from $90 to $60 (33.3% lower).');
    });
    it('R1-A05: a "$100 alternative" is no music genre; "alternative rock concerts" still are', async () => {
      expect((await x.extract({ ...base, text: BROADWAY })).genreHint ?? null).toBeNull();
      expect(await x.extract({ ...base, text: 'Any alternative rock concerts in Brooklyn next weekend?' })).toMatchObject({ genreHint: 'rock' });
    });
  });
});
