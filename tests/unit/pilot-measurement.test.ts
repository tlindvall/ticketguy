import { describe, expect, it } from 'vitest';
import { classifyOutcomeReply } from '@/lib/domain/outcome-replies';
import { problemTypesFor } from '@/lib/domain/problem-types';
import type { RequestExtraction } from '@/lib/domain/types';

const x = (over: Partial<RequestExtraction> = {}) => ({ intent: 'new_search', performerOrTeam: 'New York Rangers', eventName: null, quantity: 2, togetherRequired: null, accessibilityNeeds: null, quotedPriceCents: null, resaleAsked: null, notifyAsked: null, submittedUrls: [], ...over }) as unknown as RequestExtraction;

describe('problem types', () => {
  it('tags what the buyer needed from their words and what they sent', () => {
    expect(problemTypesFor(x({ quotedPriceCents: 10600 }), 'is $106 a good deal? should I buy now or wait?', { listing: false, link: false })).toEqual(['price_check', 'buy_or_wait']);
    expect(problemTypesFor(x({ quantity: 5, togetherRequired: true }), 'five of us, need to sit together', { listing: false, link: false })).toEqual(['find_options', 'group_seats']);
    expect(problemTypesFor(x(), 'is this seller legit? when will the tickets be delivered?', { listing: true, link: false })).toEqual(['price_check', 'delivery_timing', 'trust_or_scam']);
    expect(problemTypesFor(x({ accessibilityNeeds: 'wheelchair' }), 'wheelchair seats please', { listing: false, link: false })).toContain('accessibility');
  });
});

describe('outcome replies', () => {
  it('reads "bought", "didn’t buy" and "stop watching", and leaves anything else alone', () => {
    expect(classifyOutcomeReply('We bought them last night, thanks!')).toMatchObject({ bought: true, stopWatching: true });
    expect(classifyOutcomeReply('In the end we didn’t buy, too pricey')).toMatchObject({ bought: false, stopWatching: false });
    expect(classifyOutcomeReply('You can stop watching, plans changed')).toMatchObject({ bought: null, stopWatching: true });
    expect(classifyOutcomeReply('Can you check Knicks tickets too?')).toBeNull();
    expect(classifyOutcomeReply('thanks!')).toBeNull();
  });
  it('reads whether the advice changed what or when they bought', () => {
    expect(classifyOutcomeReply('Yes, I waited a day like you said and got them cheaper')).toMatchObject({ bought: true, changedWhen: true });
    expect(classifyOutcomeReply('We went with the ones you found, different section')).toMatchObject({ changedWhat: true });
    expect(classifyOutcomeReply('No, I bought them anyway')).toMatchObject({ changedWhat: false, changedWhen: false });
  });
});
