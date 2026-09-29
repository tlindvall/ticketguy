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
