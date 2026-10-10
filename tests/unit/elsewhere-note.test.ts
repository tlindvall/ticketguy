import { describe, expect, it } from 'vitest';
import { acknowledgementLine, elsewhereNote, elsewhereQuestion, type NearbyShow } from '@/lib/intake/pipeline';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * Live, Oct 3: "Looking for the best available Metallica tickets. Are they playing near new york soon?" got
 * "Metallica tickets soon. Got it." and "isn’t playing in New York around then, but there are shows not far off", then
 * both nights as "Thu, Nov 19 at Mohegan Sun Arena, Uncasville (about 115 miles from New York); or Sat, Nov 21 at
 * Mohegan Sun Arena, Uncasville (about 115 miles from New York)?". Said as a person would now.
 */
const x = (over: Partial<RequestExtraction>) => ({ performerOrTeam: 'Metallica', quantity: null, city: 'New York', state: 'NY', dateExpression: 'soon', resolvedLocalDate: null, budgetCents: null, budgetBasis: null, togetherRequired: null, ...over }) as unknown as RequestExtraction;
const mohegan = { id: 'v1', name: 'Mohegan Sun Arena', city: 'Uncasville', timezone: 'America/New_York' };
const show = (iso: string): NearbyShow => ({ e: { localStartAt: new Date(iso) } as NearbyShow['e'], v: mohegan as NearbyShow['v'], miles: 116, kind: 'artist' });
const now = new Date('2026-10-03T17:27:00Z');

describe('not playing where they asked, said as a person would', () => {
  it('one venue, two nights: where and how far once, the nights as a list, no "around then"', () => {
    const note = elsewhereNote('Metallica', [show('2026-11-20T00:00:00Z'), show('2026-11-22T00:00:00Z')], x({}), now);
    expect(note).toBe('Metallica isn’t playing in New York. The closest is Mohegan Sun Arena in Uncasville, about 115 miles away, on two nights:\n• Thursday, November 19, at 7 p.m.\n• Saturday, November 21, at 7 p.m.');
    expect(elsewhereQuestion([show('2026-11-20T00:00:00Z'), show('2026-11-22T00:00:00Z')], x({}))).toBe('Which night works, and how many tickets? Or tell me how far you’d travel.');
  });

  it('a month they named is kept; "soon" is never played back', () => {
    expect(elsewhereNote('Metallica', [show('2026-11-20T00:00:00Z')], x({ dateExpression: 'in November' }), now)).toMatch(/^Metallica isn’t playing in New York in November\. The closest show is at Mohegan Sun Arena in Uncasville/);
    expect(acknowledgementLine(x({ quantity: 2 }))).toBe('Two Metallica tickets. Got it.');
  });
});
