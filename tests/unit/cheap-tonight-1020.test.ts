import { describe, expect, it } from 'vitest';
import { buildPacket, PRICE_ASKED, type BuildPacketArgs } from '@/lib/advice/packet';

/**
 * Live, Oct 20: "can you find any cheap tickets to tallest man on earth at webster hall tonight?" with no resale listings
 * read got "I don't have seats to recommend yet that meet what you asked for: gA standing." as its headline, an "also"
 * sentence about Ticketmaster, a note that no listings were seen, and two questions. The price answer covers this:
 * nothing to show, where to look, send a price.
 */
const at = new Date('2026-10-20T16:00:00Z');
const args = (over: Partial<BuildPacketArgs>) => ({
  requestId: 'r', revision: 1, quantity: 2, eventLabel: 'The Tallest Man on Earth', eventNoun: 'show', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
  policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
  priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false },
  sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false, ...over,
}) as unknown as BuildPacketArgs;

describe('"any cheap tickets … tonight?" with nothing read (live Oct 20)', () => {
  it('is a price question', () => {
    expect(PRICE_ASKED.test('can you find any cheap tickets to tallest man on earth at webster hall tonight?')).toBe(true);
    expect(PRICE_ASKED.test('find me the cheapest seats')).toBe(true);
    // "The best tickets" asks for a goal, not a price.
    expect(PRICE_ASKED.test('can you find the best tickets for metallica?')).toBe(false);
  });

  it('answers with where to look and what to send, never a list of unchecked requirements or "gA"', () => {
    const p = buildPacket(args({ askedText: 'can you find any cheap tickets to tallest man on earth at webster hall tonight?', requirements: ['GA standing'] } as Partial<BuildPacketArgs>));
    const visible = p.claimRecords.filter((c) => c.customerVisible);
    expect(visible.find((c) => c.id === 'C_PRICE_ANSWER')?.text).toMatch(/^I don’t have resale prices for The Tallest Man on Earth/);
    expect(visible.map((c) => c.id)).not.toContain('C_REQS');
    expect(visible.map((c) => c.text).join(' ')).not.toMatch(/gA standing|can’t see live resale listings/);
  });

  it('a requirement that starts with an acronym keeps it ("GA standing", not "gA standing")', () => {
    const p = buildPacket(args({ askedText: 'two tickets please', requirements: ['GA standing'] } as Partial<BuildPacketArgs>));
    const reqs = p.claimRecords.find((c) => c.id === 'C_REQS');
    if (reqs) expect(reqs.text).toContain(': GA standing.');
  });
});

describe('the event is named once before the question (live Oct 20)', () => {
  it('a settled event opens the email; the request is not played back above it as well', async () => {
    const { runThread } = await import('../../evals/harness');
    const { FixtureExtractor } = await import('@/lib/ai/extraction');
    const { FixtureDrafter } = await import('@/lib/ai/drafting');
    const [turn] = await runThread({ id: 'say-once', capability: 'x', now: '2027-01-10T15:00:00Z', steps: [{ text: 'bruno mars tickets at the forum on jan 13' }] } as never, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter() });
    const reply = turn!.reply;
    expect(reply).toMatch(/That’s Bruno Mars at /);
    expect(reply).not.toMatch(/You’re after/);
    expect(reply.match(/Bruno Mars/g)).toHaveLength(1);
  }, 60_000);
});
