import { describe, expect, it } from 'vitest';
import { runThread, type Scenario, type TurnOut } from '../../evals/harness';
import { CORE } from '../../evals/scenarios/core';
import { FAMILIES } from '../../evals/scenarios/families';
import { LONG } from '../../evals/scenarios/long';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { gettingThereLine } from '@/lib/intake/asides';
import { classifyOutcomeReply } from '@/lib/domain/outcome-replies';
import { questionsAsked } from '@/lib/intake/pipeline';

/**
 * Eval issue #158, "answers a different question" (7 threads): each reply now answers what was asked, from data we hold,
 * and says what it can't check instead of repeating the last recommendation.
 */
const scenario = (id: string): Scenario => [...CORE, ...FAMILIES, ...LONG].find((x) => x.id === id)!;
const replay = (s: Scenario, listingReader?: ListingReader): Promise<TurnOut[]> => runThread(s, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), listingReader });
const at = (turns: TurnOut[], step: number) => turns.find((t) => t.step === step)!;

describe('getting there', () => {
  it('"is MSG easy to get to from Penn Station?" is answered with where the Garden is', async () => {
    const side = at(await replay(scenario('side-question')), 2);
    expect(side.emails).toHaveLength(1);
    expect(side.reply).toContain('Madison Square Garden is built directly on top of Penn Station');
    expect(side.newRecommendations).toBe(0);
  }, 60_000);
  it('a venue we hold no transit fact for still gets the pointer, never a made-up route', () => {
    expect(gettingThereLine('Richard Rodgers Theatre')).toMatch(/^Directions are outside what I check/);
    expect(gettingThereLine(null)).toMatch(/^Directions are outside what I check/);
    expect(gettingThereLine('Barclays Center')).toMatch(/Atlantic Avenue subway station/);
  });
});

describe('a level they ask about gets its price', () => {
  it('"and lower bowl, how much would that be?" over budget: the lower-bowl price first, then the pick inside it', async () => {
    const t = at(await replay(scenario('long/knicks-screenshot-alert')), 7);
    expect(t.reply).toContain('The cheapest lower-bowl pair I can see is in section 102: $1,100 total ($550 each) including the verified charges, over your $400. Inside your budget, these are the seats I’d buy:');
    expect(t.reply).toMatch(/The lower-bowl pair: https:/);
  }, 120_000);
  it('only a bigger block there: said as that, and "upper is ok" drops the line', async () => {
    const turns = await replay(scenario('long/la-january-discovery'));
    expect(at(turns, 6).reply).toContain('the only lower-bowl listing is a block of 4 in section 117, and it isn’t offered as 2');
    expect(at(turns, 7).reply).not.toMatch(/lower-bowl/);
  }, 120_000);
});

describe('a choice to buy is acknowledged', () => {
  it('"thanks, buying the 210 ones" gets one short line, not the recommendation again', async () => {
    const t = at(await replay(scenario('long/knicks-screenshot-alert')), 10);
    expect(t.emails.map((e) => e.cls)).toEqual(['acknowledgment']);
    expect(t.reply).toContain('Good pick. Buy them from the link in my last email');
    expect(t.state).toBe('closed');
  }, 120_000);
  it.each([['thanks, buying the 210 ones', true], ['ok taking those', true], ['perfect, we’ll take the section 210 seats', true], ['go with the kings. send me the link', false], ['not buying those', false], ['I am buying 4 tickets for saturday', false], ['I need to take the train', false]])('%s → buying %s', (said, buying) => {
    expect(!!classifyOutcomeReply(said)?.buying).toBe(buying);
  });
});

describe('the view, from the listing', () => {
  it('"do those balcony seats have an unobstructed view?" says what the listing says and what it can’t show', async () => {
    // Production's service depth (shadow): under enforce a show goes to the Guide, which names no seats to judge.
    const s = { id: 'date-night/view', capability: 'x', env: { SERVICE_POLICY_MODE: 'shadow' }, steps: [{ text: 'Hi! Looking for 2 tickets to Hamilton on Saturday October 10, evening show, max $500 total.' }, { text: 'Balcony could work. Do those balcony seats have an unobstructed view?' }] } as unknown as Scenario;
    const view = at(await replay(s), 2);
    expect(view.reply).toContain('The listing for section BALC, row C isn’t marked obstructed or limited view, and I leave out listings that are.');
    expect(view.reply.indexOf('isn’t marked obstructed')).toBeLessThan(view.reply.indexOf('Best verified option'));
  }, 60_000);
  it('a view question needs a question about the view', () => {
    expect(questionsAsked('Do the balcony seats have an unobstructed view?').view).toBe(true);
    expect(questionsAsked('can we see the stage from there?').view).toBe(true);
    expect(questionsAsked('2 tickets, no obstructed view please').view).toBe(false);
  });
});

/** The model's read of the blurred checkout in the eval (#151): it said the count was unclear. */
const blurredRead: ListingRead = { kind: 'checkout', sensitiveContent: false, seller: 'StubHub', eventName: 'New York Rangers vs Boston Bruins', eventDate: null, venue: 'Madison Square Garden', city: null, quantity: 3, priceText: '$720 incl. fees', priceDollars: 720, priceBasis: 'whole_party', feeBasis: 'all_in', totalDollars: 720, section: '211', row: '8', seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'medium', unreadable: ['Image is blurred; section, row, quantity and event date are less clear.', 'Event year is not shown.'] };

describe('what they sent comes first', () => {
  it('"can u beat this price" on a blurry screenshot: their price, why it can’t be compared yet, then the count', async () => {
    const [t] = (await replay(scenario('screenshot-cheaper/blurry'), { name: 'fixed', read: async () => blurredRead })) as [TurnOut];
    const reply = t.emails[0]!.text;
    expect(reply.split('\n\n')[1]).toBe('Your screenshot shows $720 in total, but I can’t make out how many tickets that covers, so I can’t compare it yet. Once I know, I’ll check it against what’s listed for the same game.');
    expect(reply).not.toMatch(/\b(?:3|three) tickets\b/);
  }, 60_000);
  it('a link to an event we can’t place says so first, never a verdict on the seats', async () => {
    const [t] = (await replay(scenario('link-good-seats/unknown-event'))) as [TurnOut];
    expect(t.emails[0]!.text.split('\n\n')[1]).toMatch(/^I couldn’t match that Ticketmaster link to an event I can check, so I can’t look at those seats yet\./);
    expect(t.reply).not.toMatch(/good seats|great seats/i);
    expect((t.reply.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  }, 60_000);
});
