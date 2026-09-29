import { describe, expect, it } from 'vitest';
import { isOffTopic, overInboundLimit } from '@/lib/intake/boundaries';
import type { RequestExtraction } from '@/lib/domain/types';

const x = (over: Partial<RequestExtraction> = {}) => ({ intent: 'new_search', performerOrTeam: null, eventName: null, categoryHint: null, genreHint: null, quantity: null, budgetCents: null, quotedPriceCents: null, submittedUrls: [], dateExpression: null, notifyAsked: null, resaleAsked: null, city: null, ...over }) as unknown as RequestExtraction;

describe('off-topic', () => {
  it('a question about a city, or an insult, is not a request', () => {
    expect(isOffTopic(x({ city: 'New York' }), 'Can you tell me something interesting about New york city? also, are you an idiot?')).toBe(true);
    expect(isOffTopic(x({ intent: 'other' }), 'hello?')).toBe(true);
  });
  it('anything that names a request is one, whatever the model called it', () => {
    expect(isOffTopic(x({ intent: 'other', performerOrTeam: 'New York Knicks' }), 'Knicks?')).toBe(false);
    expect(isOffTopic(x({ dateExpression: 'this weekend' }), 'anything fun this weekend')).toBe(false);
    expect(isOffTopic(x({ quantity: 4 }), 'four of us')).toBe(false);
    expect(isOffTopic(x(), 'can you get me seats for my dad')).toBe(false);
    expect(isOffTopic(x({ intent: 'browse' }), 'what is on')).toBe(false);
  });
});

describe('inbound limits', () => {
  it('trips above ten an hour or thirty a day', () => {
    expect(overInboundLimit({ lastHour: 10, lastDay: 30 })).toBeNull();
    expect(overInboundLimit({ lastHour: 11, lastDay: 11 })).toBe('hour');
    expect(overInboundLimit({ lastHour: 2, lastDay: 31 })).toBe('day');
  });
});
