import { describe, expect, it } from 'vitest';
import { clarificationQuestions, titleCaseName } from '@/lib/ai/extraction';
import { AMBIGUITY_KINDS, AmbiguitySchema, RequestExtractionSchema } from '@/lib/domain/types';
import type { RequestExtraction } from '@/lib/domain/types';

const brief = (over: Partial<RequestExtraction> = {}): RequestExtraction =>
  RequestExtractionSchema.parse({
    intent: 'new_search',
    eventName: null,
    performerOrTeam: 'rangers',
    city: null,
    state: null,
    dateExpression: 'tonight',
    resolvedLocalDate: null,
    quantity: 6,
    budgetCents: null,
    budgetBasis: null,
    togetherRequired: null,
    seatingPreference: null,
    accessibilityNeeds: null,
    alternativesAllowed: null,
    countryStatement: null,
    submittedUrls: [],
    evidence: [],
    ambiguities: [],
    ...over,
  });

describe('a name that means more than one team', () => {
  it('asks which one, instead of assuming it and asking for the date', () => {
    const q = clarificationQuestions(['event', 'performer_ambiguous'], brief());
    expect(q[0]).toContain('which Rangers do you mean');
    // The generic event question would take the team as settled, which is the thing in doubt.
    expect(q.join(' ')).not.toContain('Which Rangers date and venue');
  });

  it('still asks for the date and venue when the name is unambiguous', () => {
    const q = clarificationQuestions(['event'], brief({ performerOrTeam: 'Dua Lipa' }));
    expect(q[0]).toContain('Which Dua Lipa date and venue');
  });

  it('asks for a city only when it is not already asking for the whole event', () => {
    expect(clarificationQuestions(['event_location_unknown'], brief()).join(' ')).toContain('Which city or venue');
    expect(clarificationQuestions(['event', 'event_location_unknown'], brief()).join(' ')).not.toContain('Which city or venue');
  });

  it('every ambiguity in the vocabulary produces a question, so none can be silently dropped', () => {
    for (const kind of AMBIGUITY_KINDS) {
      const q = clarificationQuestions([kind], brief({ budgetCents: 50_000 }));
      expect(q.length, `${kind} produced no question`).toBeGreaterThan(0);
    }
  });
});

describe('the ambiguity vocabulary', () => {
  it('rejects a key the model invented rather than accepting it and never acting on it', () => {
    // Both of these were produced on real runs before the vocabulary was closed.
    expect(AmbiguitySchema.safeParse('rangers_ambiguous_team').success).toBe(false);
    expect(AmbiguitySchema.safeParse('which_rangers_unknown').success).toBe(false);
    expect(AmbiguitySchema.safeParse('performer_ambiguous').success).toBe(true);
  });
});

describe('names in customer-facing text', () => {
  it('capitalises what the customer typed in lower case', () => {
    expect(titleCaseName('rangers')).toBe('Rangers');
    expect(titleCaseName('new york knicks')).toBe('New York Knicks');
  });

  it('leaves existing capitalisation alone', () => {
    expect(titleCaseName('NY Rangers')).toBe('NY Rangers');
    expect(titleCaseName('Dua Lipa')).toBe('Dua Lipa');
  });
});
