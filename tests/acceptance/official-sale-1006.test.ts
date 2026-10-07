import { describe, expect, it } from 'vitest';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { FixtureDrafter } from '@/lib/ai/drafting';

/**
 * Live Oct 6, Rangers vs Islanders tonight, two tickets, $200: under the price lead the email said "For the official
 * sale: Ticketmaster also lists it as on general sale, but I can’t see whether it has seats left, or what they cost…"
 * and linked the event page. Nothing in it could be acted on. Beside resale, the official sale is suggested only with
 * something we hold about it: its face value set against the resale price, before fees on both sides, or when its
 * general sale closes. Otherwise it isn't mentioned.
 */
const NOW = new Date('2026-10-06T19:00:00Z');
const START = new Date('2026-10-06T23:00:00Z');
const pick = (section: string, row: string, priceCents: number) => ({ listing: { section, row, priceCents, quantity: 2, marketplace: null } as never, listedTotalCents: priceCents * 2, estimatedTotalCents: Math.round(priceCents * 2 * 1.3), exactSplit: true });
const base = {
  requestId: 'r', revision: 1, quantity: 2, eventLabel: 'New York Rangers vs. New York Islanders', eventParts: { title: 'New York Rangers vs. New York Islanders', where: 'Madison Square Garden, New York', when: 'Tue, Oct 6, 7:00 PM EDT' },
  eventNoun: 'game', eventCategory: 'nhl', timeZone: 'America/New_York', eventStartAt: START, best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
  policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
  priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: 20000, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
  sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: NOW, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
  market: { visible: true, basis: null, context: null, supply: { trend: 'unknown', now: null, before: null, hours: null }, comparableLabel: null },
  official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/RANGERS' },
  picks: { picks: [pick('415', '4', 8469), pick('420', '9', 9200)], fits: false, budgetTotalCents: 20000, feeAllowancePct: 30, comparable: 2, cheaperUnsplit: null, age: 'recent', links: [{ label: 'Search StubHub for this game', url: 'https://www.stubhub.com/search?q=Rangers' }] },
} as unknown as BuildPacketArgs;

async function email(over: Partial<BuildPacketArgs> = {}) {
  const packet = buildPacket({ ...base, ...over });
  const r = validateAndRender(packet, await new FixtureDrafter().draft(packet, { quantity: 2, togetherRequired: true } as never));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return { packet, text: r.textBody };
}

describe('the official sale beside a price lead', () => {
  it('the live case: nothing known about the sale but that it is open, so it is not mentioned or linked', async () => {
    const { packet, text } = await email();
    expect(packet.claimRecords.find((c) => c.id === 'C_OFFICIAL')).toBeUndefined();
    expect(text).toContain('Section 415 · Row 4');
    expect(text).not.toMatch(/can’t see whether it has seats left|official sale|also lists it as on general sale|Event page on Ticketmaster/);
  });

  it('with a face value: a comparison they can use, before fees on both sides, and the event page to check it', async () => {
    const { text } = await email({ faceValue: { minCents: 4500, maxCents: 15000 } });
    expect(text).toContain('Ticketmaster’s face value is $45 to $150 a ticket before fees: two tickets at the low end come to $90 before fees, against $169.38 before fees for the price lead above. If it still has seats near that price, they’d be cheaper, so check there first.');
    expect(text).toContain('Event page on Ticketmaster: https://www.ticketmaster.com/event/RANGERS');
    expect(text).not.toMatch(/can’t see whether it has seats left|has seats left,/);
    // Said once, inside the comparison: no separate face-value line.
    expect(text.match(/face value/g)).toHaveLength(1);
  });

  it('a face value no lower than the lead says resale is the cheaper place, with no link to go and check', async () => {
    const { packet, text } = await email({ faceValue: { minCents: 9000, maxCents: 20000 } });
    expect(text).toContain('Ticketmaster’s face value is $90 to $200 a ticket before fees, so two tickets there start at $180 before fees, no cheaper than the price lead above at $169.38 before fees. Resale is the cheaper place to look.');
    expect(packet.claimRecords.find((c) => c.id === 'C_OFFICIAL')!.url).toBeUndefined();
    expect(text).not.toContain('Event page on Ticketmaster');
  });

  it('a general sale that closes well before the event is worth saying on its own; one closing at game time is not', async () => {
    const later = { eventStartAt: new Date('2026-10-20T23:00:00Z') } as Partial<BuildPacketArgs>;
    const { text } = await email({ ...later, official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/RANGERS', saleEndsAt: new Date('2026-10-09T03:59:00Z') } });
    expect(text).toContain('Ticketmaster’s general sale for this game closes Thursday, October 8, so if you’d rather buy from the official seller, check there before then.');
    const atGameTime = await email({ official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/RANGERS', saleEndsAt: START } });
    expect(atGameTime.packet.claimRecords.find((c) => c.id === 'C_OFFICIAL')).toBeUndefined();
  });

  it('with no resale in the email, the open sale is still the place to look', async () => {
    const { packet } = await email({ picks: null });
    expect(packet.claimRecords.find((c) => c.id === 'C_OFFICIAL')?.url).toBe('https://www.ticketmaster.com/event/RANGERS');
  });
});
