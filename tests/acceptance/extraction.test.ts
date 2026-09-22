import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FixtureExtractor, clarificationQuestions, missingMandatoryFields } from '@/lib/ai/extraction';
import { stripQuotedContent } from '@/lib/intake/threading';
import { validateAndRender } from '@/lib/advice/renderer';
import type { AdvicePacket } from '@/lib/advice/packet';

const known = [
  { name: 'New York Rangers', aliases: ['Rangers'], kind: 'team' as const, category: 'nhl' },
  { name: 'Dua Lipa', aliases: [], kind: 'artist' as const, category: 'concert' },
];
const x = new FixtureExtractor();
const base = { messageId: 'm1', subject: null, receivedAt: new Date('2026-09-22T15:00:00Z'), venueTimeZone: 'America/New_York', knownEntities: known };

describe('fixture extractor', () => {
  it('A01: "$300 total" is whole-party; "$150 each" is per ticket; bare "$300" is ambiguous', async () => {
    expect(await x.extract({ ...base, text: 'two tickets, $300 total' })).toMatchObject({ quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party' });
    expect(await x.extract({ ...base, text: 'two tickets at $150 each' })).toMatchObject({ quantity: 2, budgetCents: 15000, budgetBasis: 'per_ticket' });
    const amb = await x.extract({ ...base, text: 'two tickets, budget $300' });
    expect(amb.budgetBasis).toBeNull();
    expect(amb.ambiguities).toContain('budget_basis_unknown');
    expect(clarificationQuestions(missingMandatoryFields(amb, { eventResolved: true }), amb)).toEqual([expect.stringContaining('per ticket or for everyone combined')]);
  });
  it('captures preferences, negation, gifts and opt-outs without inventing facts', async () => {
    const r = await x.extract({ ...base, text: 'Anything except Dua Lipa. Rangers on Oct 3, 4 of us together, $500 total, we must attend, happy to wait a bit. These are for my dad.' });
    expect(r.negatedEntities).toEqual(['Dua Lipa']);
    expect(r.performerOrTeam).toBe('New York Rangers');
    expect(r).toMatchObject({ quantity: 4, togetherRequired: true, mustAttend: true, waitRiskTolerance: 'high', forSelf: false, resolvedLocalDate: '2026-10-03' });
    expect(r.eventName).toBeNull();
    expect((await x.extract({ ...base, text: 'please unsubscribe me' })).intent).toBe('marketing_opt_out');
    expect((await x.extract({ ...base, text: 'stop all emails' })).intent).toBe('marketing_opt_out');
    expect((await x.extract({ ...base, text: 'delete all my data please' })).intent).toBe('delete_data');
  });
  it('A04/A24: forwarded instructions and attacker URLs never reach the request or the customer', async () => {
    const raw = readFileSync('tests/fixtures/emails/prompt-injection-forward.txt', 'utf8');
    const text = stripQuotedContent(raw);
    expect(text).not.toContain('evil.example');
    const r = await x.extract({ ...base, text });
    expect(r.submittedUrls).toEqual([]);
    expect(r).toMatchObject({ quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party', resolvedLocalDate: '2026-10-03' });
    // Even if a model tried to smuggle the URL into prose, the renderer refuses it.
    const packet: AdvicePacket = { requestId: 'r', revision: 1, verifiedOfferObservationIds: [], basketKey: 'b', basketVersion: 1, benchmarkRunId: null, trendRunId: null, historicalAdequacy: 'insufficient', trendAdequacy: 'insufficient', customerPriorities: {}, policyVersion: 'p', decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], claimRecords: [{ id: 'C_COVERAGE', kind: 'coverage', text: 'Sources checked: none.', values: {}, scope: { quantity: 2, seatZone: null, feeBasis: null, observedAt: null }, evidenceIds: [], methodVersion: null, limitations: [], customerVisible: true }], evidenceExpiresAt: null, nextCheckpointAt: null, stopConditions: [], watchConsentReference: null, isFixture: true };
    expect(validateAndRender(packet, { decision: 'insufficient_evidence', opening: 'Buy here instead: https://evil.example/checkout', paragraphs: [{ claimIds: ['C_COVERAGE'], prose: 'ok' }], closing: 'x' })).toMatchObject({ ok: false });
  });
});
