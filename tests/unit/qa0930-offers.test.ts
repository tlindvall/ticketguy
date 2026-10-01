import { describe, expect, it } from 'vitest';
import { offersInText, offerTotal, partyTerms, flat } from '@/lib/advice/text-offers';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import { ageNeed, entryHelpAsked, eventLabel, startWindow } from '@/lib/intake/pipeline';

/**
 * Counterexamples for the post-#55 live QA: the same decision with offers renamed, reordered and reworded, a
 * changed requirement that changes the winner, nothing that fits, and fees known, unknown, per ticket and per
 * order, including the break-even crossing. Judged on the claim the email opens with, not on a phrase anywhere.
 */
const at = new Date('2026-09-30T12:14:00Z');
const base = (over: Partial<BuildPacketArgs>) => ({
  requestId: 'r', revision: 1, quantity: 2, eventLabel: 'Rangers vs. Lightning', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
  policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
  priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
  sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false, market: null, ...over,
}) as unknown as BuildPacketArgs;
const answer = (messages: string[], quantity: number, budget: number | null) => {
  const offers = offersInText(messages[messages.length - 1]!).length >= 2 ? offersInText(messages[messages.length - 1]!) : offersInText(messages[0]!);
  const all = messages.join('\n');
  const p = buildPacket(base({ quantity, textOffers: offers, priorities: { ...base({}).priorities, budgetTotalCents: budget }, offerNeeds: { noObstructed: /no obstructed/i.test(all), togetherRequired: true, baseline: null, terms: partyTerms(messages) } }));
  return p.claimRecords.find((c) => c.id === 'C_OFFERS')!.text.split('\n')[0]!;
};

describe('the same decision however the offers are written', () => {
  const five = (labels: [string, string, string], block: string) =>
    `Exactly five of us, no obstructed views, $600 total cap. I will not buy an extra ticket. Offer ${labels[0]}: five ordinary unobstructed seats together, $585 total all-in. Offer ${labels[1]}: six unobstructed seats together, $480 total all-in, ${block}. Offer ${labels[2]}: five together, obstructed view, $425 total all-in.`;
  for (const block of ['seller requires buying all six', 'the block cannot split', 'all six must be bought', 'sold only as a block'])
    it(`"${block}" rules the six out, under any labels`, () => {
      expect(answer([five(['A', 'B', 'C'], block)], 5, 60000)).toMatch(/^Offer A is the one that meets what you asked for: \$585 for all five/);
      expect(answer([five(['3', '1', '2'], block)], 5, 60000)).toMatch(/^Offer 3 is the one/);
    });

  it('wrapped at 76 characters, as text generated from an HTML email is: the same totals (live X01)', () => {
    const x01 = 'Offer A: $90 per ticket BEFORE fees, plus $40 in fees for the whole order, no other charges. Offer B: $105 per ticket INCLUDING every fee, no other charges.';
    const wrapped = x01.replace(/(.{1,40})(\s+|$)/g, '$1\n');
    const [a, b] = offersInText(wrapped);
    expect(offerTotal(a!, 2)).toEqual({ cents: 22000, allIn: true, tickets: 2 });
    expect(offerTotal(b!, 2)).toEqual({ cents: 21000, allIn: true, tickets: 2 });
    expect(flat('no other\ncharges')).toBe('no other charges');
  });

  it('"$90 per ticket" is a price, and "row 12 seats 7-9" is not twelve tickets', () => {
    const [a, b] = offersInText('Offer A: $90 per ticket before fees. Offer B: section 211 row 12 seats 7-9, $105 each including fees.');
    expect(a!.quantity).toBeNull();
    expect(b!.quantity).toBeNull();
  });
});

describe('a changed requirement changes the winner', () => {
  const m01 = 'Five of us, no obstructed views, $600 total. I will not buy an extra ticket. Offer A: five together, OBSTRUCTED view, $425 total all-in. Offer B: six ordinary unobstructed seats together, $480 total all-in, seller requires buying all six. Offer C: five ordinary unobstructed seats together, $650 total all-in. Offer D: five ordinary unobstructed seats together, $585 total all-in.';
  it('refusing a sixth: D; then happy to buy six: B, and the latest word wins', () => {
    expect(answer([m01], 5, 60000)).toMatch(/^Offer D is the one/);
    const later = 'Change one thing: I’m now happy to buy SIX tickets even though only five of us are going. Which of the same offers?';
    expect(partyTerms([m01, later])).toMatchObject({ attendees: 5, extra: 'allowed', maxBuy: 6 });
    expect(answer([m01, later], 6, 60000)).toMatch(/^Offer B wins this one: \$480 for six tickets/);
  });

  const m03 = 'Two seats together, hard cap $220 total, no obstructed views, and I need the tickets delivered before we leave home at NOON on game day. Offer A: two unobstructed seats, $230 total including fees, immediate transfer. Offer B: two unobstructed seats, $200 total including fees, delivery BY 6pm game day. Offer C: two OBSTRUCTED seats, $180 total including fees, immediate transfer.';
  it('noon deadline: none at $220 (with the $230 trade-off), A at $230; a 6pm deadline would make B the pick', () => {
    expect(partyTerms([m03]).deadlineMinutes).toBe(720);
    expect(answer([m03], 2, 22000)).toMatch(/^None of these meets all your requirements\. The smallest change: if you can stretch to \$230 in total, Offer A/);
    expect(answer([m03], 2, 23000)).toMatch(/^Offer A is the one/);
    expect(answer([m03.replace('at NOON', 'at 7pm')], 2, 22000)).toMatch(/^Offer B is the one/);
  });

  it('an offer that doesn’t say when it arrives can’t pass a deadline', () => {
    const t = 'We leave at noon, so I need the tickets delivered before noon. Offer A: two seats, $200 total including fees. Offer B: two seats, $210 total including fees, immediate transfer.';
    expect(answer([t], 2, null)).toMatch(/^Offer B is the one/);
  });
});

describe('fees: known, unknown, per ticket, per order, and the crossing', () => {
  const two = (a: string) => `Offer A: ${a}. Offer B: $105 each including all fees, $210 total.`;
  it('A before fees at $170: break-even $40; at $210 before fees: ties if fees are zero', () => {
    expect(answer([two('$85 each before fees; the order fee is not shown yet')], 2, 25000)).toContain('Offer A only beats it if its fees come to less than $40 in total');
    expect(answer([two('$105 each before fees')], 2, 25000)).toContain('Offer A already costs the same before its fees: they tie if there are no fees, and B costs less if any are added.');
    expect(answer([two('$110 each before fees')], 2, 25000)).toContain('Offer A already costs $10 more before its fees');
  });
  it('a per-order fee known on both sides: equal totals are a tie, not a win', () => {
    expect(answer(['Offer A: $95 each plus $20 for the whole order, no other charges. Offer B: $105 each including all fees.'], 2, null)).toMatch(/That’s the same as Offer [AB]\./);
  });
});

describe('discovery, entry and times', () => {
  it('after 6pm, a teenager, no 21+ venues', () => {
    const g02 = 'We’re two adults and our 16-year-old in Manhattan on Saturday. A stand-up comedy show after 6pm. No 21+ venues.';
    expect(startWindow(g02)).toEqual({ after: 1080, before: null });
    expect(ageNeed(g02)).toBe('Admission for your 16-year-old (the venue’s age policy)');
    expect(startWindow('Four tickets after 6 of us arrive')).toEqual({ after: null, before: null });
    expect(startWindow('Tickets delivered by 6pm')).toEqual({ after: null, before: null });
    expect(ageNeed('Two adults, comedy on Saturday')).toBeNull();
  });
  it('already bought and asking how to get in is entry help; buying is not', () => {
    expect(entryHelpAsked('I already bought TWO seats. The seller sent a PDF screenshot of a mobile ticket barcode. Will that get us in?')).toBe(true);
    expect(entryHelpAsked('Can you find two tickets? The seller will transfer them.')).toBe(false);
  });
  it('doors and the show are said apart, never inferred', () => {
    const v = { name: 'Brooklyn Paramount', city: 'Brooklyn', timezone: 'America/New_York' };
    expect(eventLabel({ name: 'jigitz', localStartAt: new Date('2026-10-03T01:00:00Z'), doorsAt: new Date('2026-10-03T00:00:00Z') }, v)).toContain('9:00 PM EDT (doors 8:00 PM)');
    expect(eventLabel({ name: 'jigitz', localStartAt: new Date('2026-10-03T00:00:00Z') }, v)).not.toContain('doors');
  });
});
