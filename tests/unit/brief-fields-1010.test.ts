import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { EXTRACTION_SCHEMA, FixtureExtractor, deadlineInstantFrom, readDeadline, type ExtractionInput } from '@/lib/ai/extraction';
import { EXTRACTION_INSTRUCTIONS, ModelExtractor, ModelOutputError, type StructuredClient } from '@/lib/ai/model-client';
import { OpenAiClient } from '@/lib/ai/openai';
import { RequestExtractionSchema, type RequestExtraction } from '@/lib/domain/types';
import { mergeExtraction } from '@/lib/intake/pipeline';
import { pickListings, viewTier, type MarketListing } from '@/lib/market/alternatives';
import { FIXTURE_NOW } from '@/lib/fixtures';

/**
 * Audit 2026-10-10, gaps 10, 12, 13, 28 and 43: what the brief extracts and keeps. A budget's fee basis, the decision
 * deadline and what "best" means are read (rules and model), kept across follow-ups and used; the model is told what
 * every preference field means; the rules path's quirks on fallback days are gone. FIXTURE_NOW is Tuesday Sep 22 2026,
 * 11:00 in New York.
 */
const KNOWN: ExtractionInput['knownEntities'] = [
  { name: 'New York Rangers', aliases: ['Rangers', 'NY Rangers'], kind: 'team', category: 'nhl' },
  { name: 'New York Knicks', aliases: ['Knicks'], kind: 'team', category: 'nba' },
];
const input = (text: string): ExtractionInput => ({ messageId: 'm1', text, subject: null, receivedAt: FIXTURE_NOW, venueTimeZone: 'America/New_York', knownEntities: KNOWN });
const extract = (text: string) => new FixtureExtractor().extract(input(text));

describe('gap 10: a budget’s fee basis is read and kept', () => {
  it('before fees, all-in, and never from a price they saw', async () => {
    expect(await extract('Knicks on Oct 24, 2 tickets, $400 before fees')).toMatchObject({ budgetCents: 40000, budgetFeeBasis: 'before_fees' });
    expect(await extract('Two Rangers tickets on Oct 3, $300 all-in')).toMatchObject({ budgetCents: 30000, budgetBasis: 'whole_party', budgetFeeBasis: 'all_in' });
    expect(await extract('2 Knicks tickets Oct 24, max $250 not including fees')).toMatchObject({ budgetFeeBasis: 'before_fees' });
    expect((await extract('Is $106 with fees a good deal for the Knicks on Oct 24?')).budgetFeeBasis).toBeNull();
    expect((await extract('2 Knicks tickets Oct 24, $300 total')).budgetFeeBasis).toBeNull();
  });
  it('a one-line answer to the basis question is kept across the follow-up', async () => {
    const first = await extract('Knicks on Oct 24, 2 tickets, $400');
    const reply = await extract('before fees');
    expect(reply.budgetFeeBasis).toBe('before_fees');
    expect(mergeExtraction(first, reply)).toMatchObject({ budgetCents: 40000, budgetFeeBasis: 'before_fees' });
    // A later message that says nothing about fees keeps it.
    expect(mergeExtraction(mergeExtraction(first, reply), await extract('3 tickets actually')).budgetFeeBasis).toBe('before_fees');
  });
});

describe('gap 12: the decision deadline is read, never as the event’s date', () => {
  it('"by Friday", "by tomorrow", "before the 20th": the end of that day (or the day before) in the venue’s zone', async () => {
    const fri = await extract('Two Knicks tickets Oct 24, $300 total. I need to decide by Friday');
    expect(fri.decisionDeadline).toBe('2026-09-26T03:59:00.000Z'); // Fri Sep 25, 23:59 EDT
    expect(fri.resolvedLocalDate).toBe('2026-10-24'); // the game, not Friday
    const reply = await extract('By tomorrow.');
    expect(reply).toMatchObject({ decisionDeadline: '2026-09-24T03:59:00.000Z', dateExpression: null, resolvedLocalDate: null });
    // The 20th has passed this month, so it is October's; "before" ends the day before.
    expect((await extract('We have to book before the 20th')).decisionDeadline).toBe('2026-10-20T03:59:00.000Z');
  });
  it('a game "before the 20th" is the game’s dates, not a deadline', async () => {
    expect((await extract('Two Rangers tickets for a game before the 20th')).decisionDeadline).toBeNull();
    expect(readDeadline('buy tickets for a game before the 20th', FIXTURE_NOW, 'America/New_York')).toBeNull();
  });
  it('merges: the answer to "By when do you need to decide?" lands on the brief and keeps its game date', async () => {
    const first = await extract('Two Knicks tickets Oct 24, $300 total');
    const merged = mergeExtraction(first, await extract('by Friday'));
    expect(merged).toMatchObject({ decisionDeadline: '2026-09-26T03:59:00.000Z', resolvedLocalDate: '2026-10-24' });
  });
  it('the model’s date-only answer is coerced, an unreadable one is no deadline', () => {
    expect(deadlineInstantFrom('2026-10-16', 'America/New_York')).toBe('2026-10-17T03:59:00.000Z');
    expect(deadlineInstantFrom('2026-10-16', 'America/Los_Angeles')).toBe('2026-10-17T06:59:00.000Z');
    expect(deadlineInstantFrom('2026-10-16T18:00', 'America/New_York')).toBe('2026-10-16T22:00:00.000Z');
    expect(deadlineInstantFrom('2026-10-16T18:00:00-04:00', 'America/New_York')).toBe('2026-10-16T22:00:00.000Z');
    expect(deadlineInstantFrom('2026-10-16T22:00:00.000Z', 'America/New_York')).toBe('2026-10-16T22:00:00.000Z');
    expect(deadlineInstantFrom(null, 'America/New_York')).toBeNull();
  });
  it('ModelExtractor: a date-only deadline passes and is coerced; output that misses the schema is malformed, not retried', async () => {
    const base = await extract('Two Knicks tickets Oct 24, $300 total');
    const stub = (output: unknown): StructuredClient => ({ provider: 'stub', parseStructured: async () => ({ output, usage: { inputTokens: 1, outputTokens: 1 }, servedByModel: 'stub' }) }) as unknown as StructuredClient;
    const ok = await new ModelExtractor(stub({ ...base, decisionDeadline: '2026-09-25' }), 'm').extract(input('decide by Friday'));
    expect(ok.decisionDeadline).toBe('2026-09-26T03:59:00.000Z');
    const bad = new ModelExtractor(stub({ ...base, decisionDeadline: 'Friday' }), 'm').extract(input('decide by Friday'));
    await expect(bad).rejects.toBeInstanceOf(ModelOutputError);
    await expect(bad).rejects.toMatchObject({ kind: 'malformed' });
  });
  it('OpenAI: the SDK’s own parse failing on our schema is malformed, not a transport fault', async () => {
    const client = new OpenAiClient('sk-test');
    (client.client.responses as unknown as { parse: () => Promise<unknown> }).parse = async () => z.object({ decisionDeadline: z.string().datetime() }).parse({ decisionDeadline: '2026-10-16' });
    const call = client.parseStructured({ model: 'gpt-6.1-sol', instructions: 'x', input: 'y', schema: EXTRACTION_SCHEMA, schemaName: 'x', maxOutputTokens: 100, effort: 'low' });
    await expect(call).rejects.toMatchObject({ name: 'ModelOutputError', kind: 'malformed' });
  });
});

describe('the schema stays strict-mode valid and reads briefs stored before these fields', () => {
  it('every property is required, the new ones nullable, no extras', () => {
    const f = zodTextFormat(EXTRACTION_SCHEMA, 'ticket_request_extraction');
    const schema = f.schema as { required: string[]; properties: Record<string, { anyOf?: Array<{ type?: string }>; type?: string | string[] }>; additionalProperties: boolean };
    expect(f.strict).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    for (const k of ['budgetFeeBasis', 'rankingGoal', 'decisionDeadline']) {
      const p = schema.properties[k]!;
      expect(JSON.stringify(p), k).toMatch(/"null"/);
    }
    expect(() => betaZodOutputFormat(EXTRACTION_SCHEMA)).not.toThrow();
  });
  it('a stored brief without the new fields still parses, its deadline as it was', () => {
    const stored = { intent: 'new_search', eventName: null, performerOrTeam: 'New York Knicks', city: null, state: null, dateExpression: null, resolvedLocalDate: null, quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party', seatingPreference: null, togetherRequired: null, accessibilityNeeds: null, alternativesAllowed: null, submittedUrls: [], evidence: [], ambiguities: [], decisionDeadline: '2026-10-16T22:00:00.000Z' };
    expect(RequestExtractionSchema.parse(stored)).toMatchObject({ budgetFeeBasis: null, rankingGoal: null, decisionDeadline: '2026-10-16T22:00:00.000Z' });
  });
});

describe('gap 13: the model is told what each preference field means', () => {
  it('one line per field, saying what sets it and what never does', () => {
    for (const field of ['togetherRequired', 'splitGroupAllowed', 'accessibilityNeeds', 'mustAttend', 'waitRiskTolerance', 'alternativesAllowed', 'state', 'decisionDeadline', 'budgetFeeBasis', 'rankingGoal']) {
      expect(EXTRACTION_INSTRUCTIONS, field).toMatch(new RegExp(`^${field} (?:is|says) `, 'm'));
    }
    // The same words the rules extractor reads.
    expect(EXTRACTION_INSTRUCTIONS).toContain('"don\'t want to miss the game"');
    expect(EXTRACTION_INSTRUCTIONS).toContain('"neither of us needs wheelchair seating"');
    expect(EXTRACTION_INSTRUCTIONS).toContain('"together", "next to each other", "side by side"');
  });
});

describe('gap 28: what "best" means is read, kept and used for the picks', () => {
  it('view, value, price; a bare "the best tickets" is no goal', async () => {
    expect((await extract('Best view, 2 tickets')).rankingGoal).toBe('view');
    expect((await extract('good view please')).rankingGoal).toBe('view');
    expect((await extract('best seats for the Knicks on Oct 24, 2 tickets')).rankingGoal).toBe('view');
    expect((await extract('Cheapest is fine')).rankingGoal).toBe('price');
    expect((await extract('the cheapest 2 Rangers tickets Oct 3')).rankingGoal).toBe('price');
    expect((await extract('best value')).rankingGoal).toBe('value');
    expect((await extract('most bang for the buck')).rankingGoal).toBe('value');
    expect((await extract('Find me the best Knicks tickets')).rankingGoal).toBeNull();
  });
  it('the answer to the one question is kept on the brief', async () => {
    const first = await extract('Find me the best Knicks tickets');
    expect(mergeExtraction(first, await extract('Best view, 2 tickets'))).toMatchObject({ rankingGoal: 'view', quantity: 2, performerOrTeam: 'New York Knicks' });
  });
  const l = (price: number, quantity: number, section: string | null, row: string | null, zone: string | null = null): MarketListing => ({ priceCents: price * 100, quantity, section, row, zone, marketplace: 'stubhub' });
  const feed = [l(70, 4, '214', '10'), l(74, 6, '220', '4'), l(95, 4, '112', '15'), l(52, 5, '330', '1'), l(120, 4, '105', '2')];
  it('price: the cheapest that seats them, a block that may not split included', () => {
    const r = pickListings(feed, 4, 50000, 30, 3, { goal: 'price' })!;
    expect(r).toMatchObject({ rankedBy: 'price', goal: 'price', cheaperUnsplit: null });
    expect(r.picks.map((p) => p.listing.section)).toEqual(['330', '214', '220']);
  });
  it('view: lower sections and rows first within the budget; value (or no goal) is today’s order', () => {
    const v = pickListings(feed, 4, 50000, 30, 3, { goal: 'view' })!;
    expect(v.rankedBy).toBe('view');
    // 105 row 2 is $624 with the fee estimate: over $500, never picked for the view.
    expect(v.picks.map((p) => p.listing.section)).toEqual(['112', '220', '214']);
    for (const goal of ['value', null] as const) expect(pickListings(feed, 4, 50000, 30, 3, { goal })!.picks.map((p) => p.listing.section)).toEqual(['214', '220', '112']);
    expect(pickListings(feed, 4, 50000, 30)!.picks.map((p) => p.listing.section)).toEqual(['214', '220', '112']);
  });
  it('view with no section, row or zone to go by: by price, and said so', () => {
    const r = pickListings([l(70, 4, null, null), l(60, 4, 'GA', null)], 4, null, 30, 3, { goal: 'view' })!;
    expect(r).toMatchObject({ goal: 'view', rankedBy: 'value' });
    expect(r.picks[0]!.listing.priceCents).toBe(6000);
  });
  it('view tiers come only from the feed’s words and numbers', () => {
    expect(viewTier(l(1, 1, '112', null))).toBe(0);
    expect(viewTier(l(1, 1, 'Mezzanine 3', null))).toBe(1);
    expect(viewTier(l(1, 1, 'Upper Level 312', null))).toBe(2);
    expect(viewTier(l(1, 1, 'C', null, 'Club Level'))).toBe(0);
    expect(viewTier(l(1, 1, 'Floor GA', null))).toBeNull();
    expect(viewTier(l(1, 1, null, null))).toBeNull();
  });
  it('gap 10: a budget before fees is held against the listed total, all-in against the fee estimate', () => {
    // $280 listed, $364 with the 30% estimate, against $300.
    expect(pickListings([l(70, 4, '214', '10')], 4, 30000, 30, 3, { budgetFeeBasis: 'before_fees' })).toMatchObject({ fits: true, budgetFeeBasis: 'before_fees' });
    expect(pickListings([l(70, 4, '214', '10')], 4, 30000, 30, 3, { budgetFeeBasis: 'all_in' })).toMatchObject({ fits: false });
    expect(pickListings([l(70, 4, '214', '10')], 4, 30000, 30)).toMatchObject({ fits: false });
  });
});

describe('gap 43: rules-path quirks', () => {
  it('a count is not a team in a matchup', async () => {
    expect((await extract('Two tickets vs Lightning on Oct 3')).eventName).toBeNull();
    expect((await extract('4 Knicks tickets vs Celtics on Oct 24')).eventName).toBe('Knicks vs Celtics');
    expect((await extract('Rangers vs Lightning, 2 tickets')).eventName).toBe('Rangers vs Lightning');
  });
  it('"the same game" is the settled event, not a browse', async () => {
    const x = await extract('Can you find a cheaper pair for the same game?');
    expect(x.intent).not.toBe('browse');
    expect(x.categoryHint).toBeNull();
    // A kind of event with nothing named is still a browse.
    expect((await extract('any hockey games in New York next week?')).intent).toBe('browse');
  });
  it('a terse follow-up keeps a watch request a watch; "thanks" changes nothing; a named new event still does', async () => {
    const watch = await extract('Knicks on October 24, 2 tickets, $300 total. Let me know if it drops.');
    expect(watch.intent).toBe('watch_request');
    expect(mergeExtraction(watch, await extract('Make it 3 tickets, $400 total')).intent).toBe('watch_request');
    const other: RequestExtraction = { ...(await extract('thanks!')), intent: 'other' };
    expect(mergeExtraction(watch, other).intent).toBe('watch_request');
    expect(mergeExtraction(watch, await extract('Actually Rangers on Oct 3 instead, 2 tickets')).intent).toBe('new_search');
  });
});
