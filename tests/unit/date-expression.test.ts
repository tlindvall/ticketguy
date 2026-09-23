import { describe, expect, it } from 'vitest';
import { monthWindowFor } from '@/lib/domain/dates';
import { FixtureExtractor } from '@/lib/ai/extraction';

const RECEIVED = new Date('2026-09-23T15:00:00Z');

describe('month windows', () => {
  it('reads a month named without a day', () => {
    expect(monthWindowFor('sometime in November', RECEIVED)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthWindowFor('in Nov', RECEIVED)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthWindowFor('during november', RECEIVED)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('rolls a month already past into next year', () => {
    expect(monthWindowFor('in March', RECEIVED)).toEqual({ from: '2027-03-01', to: '2027-03-31' });
    expect(monthWindowFor('in november 2027', RECEIVED)).toEqual({ from: '2027-11-01', to: '2027-11-30' });
  });

  it('is not a month window when a day is named', () => {
    expect(monthWindowFor('Oct 3', RECEIVED)).toBeNull();
    expect(monthWindowFor('in October 3', RECEIVED)).toBeNull();
    expect(monthWindowFor('in 3 days', RECEIVED)).toBeNull();
    expect(monthWindowFor('tomorrow', RECEIVED)).toBeNull();
  });

  it('handles month lengths', () => {
    expect(monthWindowFor('in February', RECEIVED)?.to).toBe('2027-02-28');
    expect(monthWindowFor('in February 2028', RECEIVED)?.to).toBe('2028-02-29');
  });
});

const extract = (text: string) =>
  new FixtureExtractor().extract({ messageId: 'm1', text, subject: null, receivedAt: RECEIVED, venueTimeZone: 'America/New_York', knownEntities: [{ name: 'New York Knicks', aliases: ['knicks'], kind: 'team', category: 'nba' }] });

describe('extraction of a loosely-worded request', () => {
  it('captures a bare month as the date expression', async () => {
    const x = await extract('my wife and I want to see the knicks sometime in November, flexible on price');
    expect(x.dateExpression).toMatch(/november/i);
    expect(x.resolvedLocalDate).toBeNull(); // a month is not a day
  });

  it('counts "my wife and I" as two', async () => {
    expect((await extract('my wife and I want to see the knicks sometime in November')).quantity).toBe(2);
    expect((await extract('me and my partner want knicks tickets')).quantity).toBe(2);
  });

  it('counts a party named as a family or household', async () => {
    expect((await extract('Looking for knicks tickets for my family of 4 in november')).quantity).toBe(4);
    expect((await extract('need seats for my family of four in november')).quantity).toBe(4);
    expect((await extract('party of 3 for the knicks in november')).quantity).toBe(3);
  });

  it('does not read "flexible on price" as flexible about attending', async () => {
    // mustAttend drives the buy/wait decision, so a guess here changes the advice a customer receives.
    expect((await extract('knicks tickets sometime in November, flexible on price')).mustAttend).toBeNull();
    expect((await extract('knicks tickets in November, we are flexible on the date')).mustAttend).toBe(false);
    expect((await extract('knicks tickets in November, we definitely have to go')).mustAttend).toBe(true);
  });
});
