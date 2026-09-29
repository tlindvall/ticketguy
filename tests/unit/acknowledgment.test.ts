import { describe, expect, it } from 'vitest';
import { acknowledgedFacts } from '@/lib/intake/pipeline';
import { renderTemplate } from '@/lib/email/templates';
import type { RequestExtraction } from '@/lib/domain/types';

describe('the acknowledgment reads like a person jotting down the request', () => {
  const text = "Hey hey, Tobias here. I'm looking to get 5 tickets to the new york rangers v tampa bay lightning game this week. Should I buy now or hold off closer to the game?";
  const brief = { quantity: 5, togetherRequired: null, budgetCents: null, budgetBasis: null, quotedPriceCents: null, resaleAsked: null } as unknown as RequestExtraction;
  const facts = acknowledgedFacts({ name: 'New York Rangers vs. Tampa Bay Lightning', category: 'nhl', localStartAt: new Date('2026-10-01T23:00:00Z') }, { name: 'Madison Square Garden', city: 'New York', timezone: 'America/New_York' }, brief, text);

  it('lists the game, when, where, how many and their question', () => {
    expect(facts).toEqual([
      'Game: New York Rangers vs. Tampa Bay Lightning',
      'When: Thu, Oct 1, 7:00 PM EDT',
      'Where: Madison Square Garden, New York',
      'Tickets: 5',
      'You asked: whether to buy now or hold off',
    ]);
  });

  it('says what happens next, personally, and promises no review and no purchase line', () => {
    const r = renderTemplate('acknowledgment', { eventLabel: 'x', knownFacts: facts }, { appUrl: 'https://ticketguy.now', postalAddress: null, signature: 'full' });
    expect(r.text.startsWith("Hey,\n\nGot it. Here's what I have:\n• Game: New York Rangers vs. Tampa Bay Lightning")).toBe(true);
    expect(r.text).toContain("I'll look at how the tickets are trading and come back to you shortly. If anything above is off, just reply.");
    for (const gone of ['a person checks every answer', 'No purchases happen', 'What we understood']) expect(r.text).not.toContain(gone);
  });
});
