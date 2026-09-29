import { describe, expect, it } from 'vitest';
import { buildPacket, quoteVerdict, type BuildPacketArgs } from '@/lib/advice/packet';

const face = { minCents: 5500, maxCents: 9500 };

describe('a price the customer saw, against face value', () => {
  it('says below, within, fees-sized above, or a markup', () => {
    expect(quoteVerdict(4000, face)).toBe('below');
    expect(quoteVerdict(9500, face)).toBe('within');
    expect(quoteVerdict(10600, face)).toBe('fees');
    expect(quoteVerdict(20000, face)).toBe('markup');
  });

  it('with no market data, answers the question and keeps our integrations out of the email', () => {
    const args = {
      requestId: 'r', revision: 1, quantity: 2, eventLabel: 'x', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
      policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p' },
      priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null },
      sourcesChecked: [], sourcesUnavailable: [{ sourceId: 'stubhub', status: 'not_integrated' }, { sourceId: 'seatgeek', status: 'not_integrated' }],
      independentOptionCount: 0, observedAt: new Date('2026-09-28T23:32:00Z'), evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
      official: { seller: 'Ticketmaster', url: 'https://www.ticketmaster.com/e/1' }, faceValue: null, quote: { perTicketCents: 10600, assumedPerTicket: true },
    } as unknown as BuildPacketArgs;
    const p = buildPacket(args);
    const byId = Object.fromEntries(p.claimRecords.map((c) => [c.id, c]));
    expect(byId.C_QUOTE!.text).toBe('You mentioned $106 (I’ve taken that as per ticket). Ticketmaster doesn’t publish a price range for this show, so I can’t size that against face value. But if $106 is Ticketmaster’s own price, it’s face value, not a resale markup.');
    expect(byId.C_OFFICIAL!.linkLabel).toBe('Buy on Ticketmaster');
    expect(byId.C_COVERAGE!.text).toBe('I can’t see live resale listings for this show yet, so this doesn’t compare other sellers’ prices.');
    expect(byId.C_NOHIST).toBeUndefined(); // no history line when there was no market to compare
    expect(byId.C_COUNT).toBeUndefined(); // no "0 qualifying listings among the sources we checked"
    expect(JSON.stringify(p.claimRecords.map((c) => c.text))).not.toContain('stubhub');
  });
});

describe('where a price came from, and what face value means', () => {
  const args = (over: Partial<BuildPacketArgs>) => ({
    requestId: 'r', revision: 1, quantity: 2, eventLabel: 'x', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p' },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null },
    sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: new Date('2026-09-28T23:32:00Z'), evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    official: null, faceValue: face, ...over,
  }) as unknown as BuildPacketArgs;
  const quoteText = (over: Partial<BuildPacketArgs>) => buildPacket(args(over)).claimRecords.find((c) => c.id === 'C_QUOTE')!.text;

  it('below face value is a reason to check the seats, never "a good price"', () => {
    const t = quoteText({ quote: { perTicketCents: 4000, assumedPerTicket: false } });
    expect(t).toContain('below the face value');
    expect(t).toContain('not what seats are worth now');
    expect(t).not.toMatch(/good (price|deal)/i);
  });

  it('well above face value is not called a bad price, and says when there is no market to compare', () => {
    const t = quoteText({ quote: { perTicketCents: 20000, assumedPerTicket: false } });
    expect(t).toContain('doesn’t make it a bad price');
    expect(t).toContain('I can’t see current resale prices for this show');
  });

  it('a screenshot price is what the listing showed, not a verified offer', () => {
    const t = quoteText({ quote: { perTicketCents: 10600, assumedPerTicket: false, source: 'screenshot', feeBasis: 'all_in', seller: 'StubHub' } });
    expect(t.startsWith('The screenshot you sent shows $106 a ticket including fees on StubHub. That’s what the listing showed when you took it; I haven’t checked that the seats are still there.')).toBe(true);
  });

  it('a pasted listing and a typed price are each said as what they are', () => {
    expect(quoteText({ quote: { perTicketCents: 10600, assumedPerTicket: false, source: 'listing_text' } })).toMatch(/^The listing you pasted shows \$106 a ticket\./);
    expect(quoteText({ quote: { perTicketCents: 10600, assumedPerTicket: true } })).toMatch(/^You mentioned \$106 \(I’ve taken that as per ticket\)\./);
  });

  it('face value alone is labelled as the original price', () => {
    const t = buildPacket(args({ quote: null })).claimRecords.find((c) => c.id === 'C_FACE')!.text;
    expect(t).toContain('That’s what the original seller charged, not what seats sell for now.');
  });
});
