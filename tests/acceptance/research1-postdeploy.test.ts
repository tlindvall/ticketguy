import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, makeConcierge, testEnv } from '../harness';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { partyTerms } from '@/lib/advice/text-offers';
import { decisionAnswer } from '@/lib/advice/decision-questions';

/**
 * Research 1 post-deploy retest (Oct 1 2026, build a173486). The exact customer messages from the QA package
 * (scenario-plan.json, EXECUTED_PLAN.json and WORDING_ISOLATION_CONTROLS.json), not rebuilt texts: three live
 * follow-ups that ignored a held ticket or a changed preference, and the local comedy and lottery turns that
 * dropped a supplied rule, a quote and a win. Quotes and rules are the customer's hypotheticals: nothing here
 * is checked stock, a fetched policy or a real event.
 */
type Local = { opening: string; followup: string; control: string };
type Wording = { messages: string[]; field: string; expected: unknown };
const F = JSON.parse(readFileSync('tests/fixtures/r1-deployed-regression-2026-10-01.json', 'utf8')) as { live: Record<'01' | '02' | '03', [string, string]>; local: Record<string, Local>; wording: Record<string, Wording> };
const NOW = FIXTURE_NOW;
const COMEDY = F.local['R1-09-COMEDY-MINIMUM']!;
const LOTTERY = F.local['R1-08-BROADWAY-LOTTERY']!;
const FAMILY = F.local['R1-08-FAMILY-LAP-CHILD']!;
const W = F.wording;

/** Nothing a reply may claim: a checked view, live stock, a purchase or a generic research task. */
const NEVER = /Before you buy, check|check its delivery|better view|unobstructed view is|great view|in stock|I(?:’ve| have) (?:checked|verified|reserved|bought)|Got it|on file for/;
const BODY = (x: string) => x.replace(/^Hey,\n\n/, '');
const lead = (x: string) => BODY(x).split('\n')[0]!;

describe('Research 1 post-deploy retest: exact inputs', () => {
  let h: DbHandle;
  let n = 0;
  type Turn = { text: string; quantity: number | null; transition: string | null };
  const converse = async (turns: string[]): Promise<Turn[]> => {
    const c = makeConcierge(h, { now: () => NOW, env: testEnv({ SERVICE_POLICY_MODE: 'enforce' }) });
    n += 1;
    let prev: ReturnType<typeof inbound> | null = null;
    const out: Turn[] = [];
    for (const text of turns) {
      const m = inbound({ text, from: `r1pd-${n}@customer.example`, subject: prev ? 'Re: Tickets' : 'Tickets', inReplyTo: prev?.rfcMessageId ?? null, references: prev?.rfcMessageId ?? null });
      const r = (await c.ingestInbound(m)) as { requestId: string };
      prev = m;
      for (let i = 0; i < 8; i++) {
        const leased = await leaseDueOutbox(h.db, { limit: 50, now: NOW });
        if (!leased.length) break;
        for (const ev of leased) {
          const p = ev.payload as Record<string, string>;
          if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
          else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
          await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
        }
      }
      // Ordered by revision: rows written at the same pinned clock come back in no set order.
      const sends = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))).sort((a, b) => (a.requestRevision ?? 0) - (b.requestRevision ?? 0));
      expect(sends).toHaveLength(out.length + 1);
      const versions = (await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, r.requestId))).sort((a, b) => a.revision - b.revision);
      const transitions = (await h.db.select().from(t.requestTransitions).where(eq(t.requestTransitions.requestId, r.requestId))).sort((a, b) => a.revision - b.revision);
      const body = sends.at(-1)!.bodyText.split('\nTicket Guy\n')[0]!.trim();
      expect(body).not.toMatch(NEVER);
      out.push({ text: body, quantity: (versions.at(-1)!.brief as { quantity: number | null }).quantity, transition: transitions.at(-1)?.reason ?? null });
    }
    return out;
  };

  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  describe('R1-M02 and R1-PREF-01: the three live pairs, exact messages', () => {
    it('01: the $250 cap lets the preferred lower tier fit, so B, and the reply says why it changed', async () => {
      const [first, second] = await converse(F.live['01']);
      expect(lead(first!.text)).toBe('Offer A is the one that meets what you asked for: $190 for both, fees included. Skip C: it’s an upgrade with no concert admission, so its $100 doesn’t get either of you into the show. It leaves $10 of your $200 budget. Based on the details you sent; I haven’t verified availability.');
      expect(lead(second!.text)).toBe('With your budget now $250, the lower tier fits, so I’d choose B: $240 for both, fees included. That’s $50 more than Offer A, the other usable option, and the lower tier is what you said you’d prefer. It leaves $10 of your $250 budget. That’s based on your quotes; I haven’t verified availability or the view.');
      // C is still out: an upgrade gets no one in.
      expect(second!.text).toContain('Offer C (two, upgrade): $100 in total including fees. It includes no concert admission, so it cannot get you into the show and is excluded from the admission comparison.');
      expect(second!.quantity).toBe(2);
    });

    it('02: the held ticket survives the new friend: A for two new tickets, then B for three, never four', async () => {
      const [first, second] = await converse(F.live['02']);
      expect(lead(first!.text)).toBe('Offer A wins this one: $180 for the two new tickets, fees included. Your own ticket is already covered. That’s $60 less than Offer B. It leaves $70 of your $250 budget. Based on the details you sent; I haven’t verified availability.');
      expect(first!.quantity).toBe(2);
      expect(lead(second!.text)).toBe('With one more new ticket to buy, B is the one: $240 for the three new tickets, fees included. Your own ticket is already covered. Skip A: it has only two admissions, and you need three new ones, so it would leave one person out. It leaves $10 of your $250 budget. Based on the details you sent; I haven’t verified availability.');
      expect(second!.text).not.toMatch(/\bfour\b|None of the two/i);
      expect(second!.quantity).toBe(3);
    });

    it('03: saving first picks A; the changed preference picks B and says the change, not the old reason', async () => {
      const [first, second] = await converse(F.live['03']);
      expect(lead(first!.text)).toBe('I’d take A for you: $240 for both, fees included. It leaves $60 under your $300 cap. Offer B costs $45 more for the lower tier; since keeping the spend down matters most to you, I wouldn’t pay that difference on the facts you’ve supplied. That’s based on your quotes; I haven’t verified availability or the view.');
      expect(lead(second!.text)).toBe('Since you’d now pay more for the lower tier, I’d choose B: $285 for both, fees included. That’s $45 more than Offer A. It leaves $15 of your $300 budget. That’s based on your quotes; I haven’t verified availability or the view.');
      expect(second!.text).not.toContain('keeping the spend down');
    });
  });

  describe('R1-M02 and R1-PREF-01: controls', () => {
    it('wording controls from the package: the exact phrasings now read like their equivalents', () => {
      for (const id of ['owned-exact', 'owned-equivalent-control']) expect(partyTerms(W[id]!.messages).toBuy).toBe(3);
      for (const id of ['preference-exact', 'preference-equivalent-control']) expect(partyTerms(W[id]!.messages).priority).toEqual({ kind: 'feature', words: 'lower tier' });
    });

    it('held-ticket paraphrases are read; a ticket for the wrong date, or one not yet owned, is not', () => {
      for (const s of ['I already own my concert ticket.', 'I already have my own ticket.', 'my already-owned ticket plus two friends', 'I already have mine.']) expect(partyTerms([s]).owned).toBe(1);
      for (const s of ['I bought a ticket for the wrong date.', 'I don’t own my concert ticket yet.']) expect(partyTerms([s]).owned).toBeNull();
      expect(partyTerms(['I don’t already own any tickets.']).owned).not.toBe(1);
    });

    it('an unclear held ticket is not guessed: the party is the purchase', () => {
      const terms = partyTerms(['Three of us are going; one of us might already have a ticket.']);
      expect(terms).toMatchObject({ attendees: 3, owned: null, toBuy: null });
    });

    it('preference paraphrases are a feature priority; a refusal of the premium is not', () => {
      for (const s of ['I prefer the lower tier when it fits my budget.', 'lower-tier preference', 'I now value being in the lower tier enough to pay the difference.', 'I would rather have the lower tier.']) expect(partyTerms([s]).priority).toEqual({ kind: 'feature', words: 'lower tier' });
      for (const s of ['The lower tier isn’t worth the difference to me.', 'I don’t prefer the lower tier.']) expect(partyTerms([s]).priority).toBeNull();
      expect(partyTerms(['Keeping the spend down is my top priority.']).priority).toEqual({ kind: 'price' });
    });

    it('too small a budget still restricts: the lower-tier preference at $280 keeps A, with no change claimed', async () => {
      const [, second] = await converse([F.live['03'][0], F.live['03'][1].replace('the same $300 total cap', 'a new $280 total cap')]);
      expect(lead(second!.text)).not.toMatch(/I’d choose B|Since you’d now pay/);
      expect(second!.text).toContain('Offer B (two together, lower-tier): $285 in total including fees. Over your $280 budget by $5.');
    });

    it('four genuinely new admissions: a useful no, with no invented stock', async () => {
      const five = 'Another friend is joining. Now FIVE of us are going: my already-owned ticket plus FOUR friends who each need a new ticket. Keep the same $250 all-in budget for the new tickets only and the same fixed bundles. Which bundle covers the new purchase now?';
      const [, second] = await converse([F.live['02'][0], five]);
      expect(lead(second!.text)).toMatch(/^None of the two meets all your requirements\./);
      expect(second!.text).toContain('It has only three admissions, and you need four new ones, so it would leave one person out.');
      expect(second!.quantity).toBe(4);
    });
  });

  describe('R1-A02-MINIMUM: the comedy rule, exact messages', () => {
    it('opening and follow-up: $48 is entry only, then $84 total with $16 room', async () => {
      const [first, second] = await converse([COMEDY.opening, COMEDY.followup]);
      expect(first!.text.split('\n')[0]).toBe('$48 covers entry for the two of you, not the whole night.');
      expect(first!.text).not.toContain('rule you supplied');
      expect(second!.text.split('\n')[0]).toBe('With your supplied prices, that’s $84 total, $16 under your cap.');
      expect(second!.text).toContain('$48 cover + four $9 items = $84.');
    });

    it('supplied-rule control: two items per attendee, four for two, no alcohol required, the link and what is missing', async () => {
      const [only] = await converse([COMEDY.control]);
      expect(only!.text.split('\n')[0]).toBe('$48 covers entry for the two of you, not the whole night.');
      expect(only!.text).toContain('The rule you supplied says two qualifying items per person (four for the two of you), and food or non-alcoholic drinks count, so you don’t have to buy alcohol.');
      expect(only!.text).toContain('Here is the policy you sent: https://comedycellar.com/reservations/. I haven’t checked it myself in this reply.');
      expect(only!.text).toContain('What’s missing is the price of those four items');
      expect(only!.transition).toBe('decision:minimum_spend');
    });

    it('wording controls: "per attendee" and "per person" read the same; no rule keeps the general line', () => {
      for (const id of ['minimum-rule-exact', 'minimum-rule-equivalent-control']) expect(decisionAnswer(W[id]!.messages)!.items[0]).toMatch(/^The rule you supplied says two qualifying items per person \(four for the two of you\)/);
      expect(decisionAnswer([COMEDY.control.replace('per attendee', 'per guest')])!.items[0]).toMatch(/^The rule you supplied says two/);
      expect(decisionAnswer([COMEDY.opening])!.items[0]).toMatch(/^Food and drink are extra/);
      // A sentence of their own after the rule isn't read as the rule.
      const own = COMEDY.control.replace('It does not require two alcoholic drinks.', 'We would rather drink water.');
      expect(decisionAnswer([own])!.items[0]).toContain('food or non-alcoholic drinks count');
    });
  });

  describe('R1-A02-LOTTERY: state, quote and terms, exact messages', () => {
    it('opening: not the plan before the draw; the $220 adjacent pair is, with $20 left', async () => {
      const [first] = await converse([LOTTERY.opening]);
      expect(first!.text).toBe([
        'I wouldn’t count the lottery as your guaranteed plan.',
        'Before the draw, a lottery is a chance to buy, not a ticket.',
        'The two adjacent seats you quoted meet your sit-together requirement at $220 total, leaving $20 of your $240. For a one-night visit, that’s the safer plan.',
        'Based only on the facts you supplied; I haven’t checked availability.',
      ].join('\n\n'));
      expect(first!.quantity).toBe(2);
    });

    it('follow-up: the win is acknowledged, seats together are still unconfirmed, and the pair still fits', async () => {
      const [, second] = await converse([LOTTERY.opening, LOTTERY.followup]);
      expect(second!.text.split('\n')[0]).toBe('Winning lets you buy, but it doesn’t confirm seats together: no seat assignment has come with it.');
      expect(second!.text).toContain('Since sitting together is a must, the lottery seats ($50 each, $100 for both) are the plan only once the seats offered are shown together. Otherwise: the two adjacent seats you quoted meet your sit-together requirement at $220 total, leaving $20 of your $240.');
      expect(second!.text).not.toContain('Before the draw');
    });

    it('supplied-terms control: the no-adjacency clause after the source sentence is used, and the status is said once', async () => {
      const [only] = await converse([LOTTERY.control]);
      expect(only!.text).toContain('The terms you supplied also say even winning doesn’t guarantee adjacent seats.');
      expect(only!.text).toContain('$220 total, leaving $20 of your $240');
      expect(only!.text).toContain('Here are the lottery terms you sent: https://lottery.broadwaydirect.com/terms/. This rests on them and your quotes; I haven’t checked the terms or availability myself.');
      expect(only!.text.match(/I haven’t checked/g)).toHaveLength(1);
    });

    it('wording controls: won and unwon paraphrases; adjacent and non-adjacent quotes', () => {
      for (const id of ['lottery-win-exact', 'lottery-win-equivalent-control']) expect(decisionAnswer(W[id]!.messages)!.lead).toMatch(/^Winning lets you buy/);
      for (const id of ['lottery-adjacent-quote-exact', 'lottery-adjacent-quote-equivalent-control']) expect(decisionAnswer(W[id]!.messages)!.items.join(' ')).toContain('$220 total, leaving $20 of your $240');
      const won = (s: string) => decisionAnswer([LOTTERY.opening, s])!.lead;
      for (const s of ['Update: we were selected. Does that confirm seats together?', 'Assume I’ve just won. Does that settle seats together?']) expect(won(s)).toMatch(/^Winning lets you buy/);
      for (const s of ['Update: I still haven’t won. Can I count on it?', 'We didn’t win this time. Can I plan on it?']) expect(won(s)).toBe('I wouldn’t count the lottery as your guaranteed plan.');
      // A quote not described as together never meets the requirement, and isn't called the plan.
      const apart = LOTTERY.opening.replace('two actual adjacent seats for the same performance for $220 TOTAL all-in', 'two seats in different rows for $200 TOTAL all-in');
      const r = decisionAnswer([apart])!;
      expect(r.items.join(' ')).toContain('The two seats aren’t described as seats together, so they don’t meet your must-sit-together requirement.');
      expect(r.items.join(' ')).not.toMatch(/meet your sit-together requirement at|safer plan/);
    });

    it('a rule names its own operator: terms without the adjacency clause say nothing about adjacency', () => {
      const plain = LOTTERY.control.replace(' Even winning does not guarantee adjacent seats.', '');
      expect(decisionAnswer([plain])!.items.join(' ')).not.toContain('guarantee adjacent');
    });
  });

  describe('Family admission: unchanged', () => {
    it('23 months asks which arena; 25 months is three admissions with no discount promised; the FAQ control keeps its link', async () => {
      const [first, second] = await converse([FAMILY.opening, FAMILY.followup]);
      expect(first!.text).toContain('Which arena and performance are you looking at? That settles it.');
      expect(second!.text.split('\n')[0]).toBe('At 25 months, most family shows require a child’s own ticket: three admissions for your family.');
      expect(second!.quantity).toBe(3);
      const [only] = await converse([FAMILY.control]);
      expect(only!.text).toContain('Here is the FAQ you sent: https://www.disneyonice.com/en-us/faq/.');
      expect(only!.text).toContain('the arena can require a ticket at every age');
    });
  });
});
