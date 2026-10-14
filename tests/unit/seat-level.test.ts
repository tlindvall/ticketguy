import { describe, expect, it } from 'vitest';
import { seatLevelOf, seatLevelWanted } from '@/lib/domain/seat-level';

describe('seatLevelWanted', () => {
  it.each([
    ['5 tickets, lower bowl please', 'lower'],
    ['anything in the 100 level', 'lower'],
    ['upper deck seats', 'upper'],
    ['nosebleeds are all we can afford', 'upper'],
    ['lower bowl is fine', null],
    ['upper deck if needed', null],
    ['not the upper deck', null],
    ['at a lower price', null],
    ['2 tickets for Saturday', null],
  ] as const)('%s → %s', (text, want) => expect(seatLevelWanted(text)).toBe(want));
});

describe('seatLevelOf', () => {
  it.each([
    [{ seatClass: 'Lower Level' }, 'lower'],
    [{ seatClass: 'balcony' }, 'upper'],
    [{ section: '110' }, 'lower'],
    [{ section: 'Section 224' }, 'upper'],
    [{ section: 'Floor A' }, null],
  ] as const)('%o → %s', (o, level) => expect(seatLevelOf(o)).toBe(level));
});
