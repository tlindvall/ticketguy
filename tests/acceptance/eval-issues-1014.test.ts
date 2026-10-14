import { describe, expect, it } from 'vitest';
import { runThread, type Scenario, type TurnOut } from '../../evals/harness';
import { CORE } from '../../evals/scenarios/core';
import { FAMILIES } from '../../evals/scenarios/families';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';

/**
 * Eval findings of Oct 14 2026 (issues #136-#138, #147-#151), replayed on the eval world with the rule-based AI so they
 * run without a model key. The model evals (pnpm eval) cover the same threads with the real extractor and drafter.
 */
const scenario = (id: string): Scenario => {
  const s = [...CORE, ...FAMILIES].find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};
/** The answer itself: the last email of the turn (an acknowledgment may come before it). */
const answer = (t: TurnOut): string => t.emails.at(-1)?.text ?? '';
const replay = (s: Scenario | string): Promise<TurnOut[]> => runThread(typeof s === 'string' ? scenario(s) : s, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter() });

describe('a seating preference picks the seats (#138)', () => {
  it('"lower bowl please" recommends the lower-bowl seats inside the budget, not a cheaper upper-level pair', async () => {
    const [turn] = (await replay('lower-bowl')) as [TurnOut];
    expect(turn.reply).toMatch(/section 110/i);
    expect(turn.reply.split('\n').slice(0, 6).join('\n')).not.toMatch(/section 224/);
  }, 60_000);

  it('never says the customer ruled out an obstructed view they never mentioned', async () => {
    const turns = await replay('side-question');
    for (const t of turns) expect(t.reply).not.toMatch(/which you ruled out/i);
  }, 60_000);
});

describe('availability is answered first (#147, #148)', () => {
  it('"do tickets still exist?" with nothing listed says so in the first lines, and asks one thing at most', async () => {
    const [turn] = (await replay('concert-availability-soldout/clean')) as [TurnOut];
    const reply = answer(turn);
    const top = reply.split('\n\n').slice(0, 4).join('\n');
    expect(top).toMatch(/couldn’t find any tickets|no resale listings/i);
    expect(turn.reply).not.toMatch(/How many tickets do you need/);
    expect(reply).not.toMatch(/0 qualifying listings/);
    expect((reply.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('an event not on sale yet says when the sale opens, with one question at most', async () => {
    const [turn] = (await replay('concert-not-on-sale/clean')) as [TurnOut];
    const reply = answer(turn);
    expect(reply).toMatch(/isn’t on sale yet: the public sale opens Fri, Oct 2/);
    expect(reply).not.toMatch(/0 qualifying listings|Found seats you like/);
    expect((reply.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  }, 60_000);
});

describe('"are these good seats?" is answered with a verdict on them (#149)', () => {
  it('opens on the level, the row and the price against the lower bowl', async () => {
    const [turn] = (await replay('link-good-seats/ticketmaster')) as [TurnOut];
    const lead = answer(turn).split('\n\n').find((p) => /section 224/i.test(p)) ?? '';
    expect(lead).toMatch(/upper level/);
    expect(lead).toMatch(/row G/);
    expect(lead).toMatch(/lower bowl starts at \$540/);
    expect(answer(turn).indexOf(lead)).toBeLessThan(answer(turn).indexOf('I left out'));
  }, 60_000);

  it('never judges seats for an event it can’t place', async () => {
    const turns = await replay('link-good-seats/unknown-event');
    for (const t of turns) expect(t.reply).not.toMatch(/good seats|great seats/i);
  }, 60_000);
});

/** The model's read of the blurred checkout in the eval (#151): 5 tickets read as 3, row B as 8, and it said so. */
const blurredRead: ListingRead = { kind: 'checkout', sensitiveContent: false, seller: 'StubHub', eventName: 'New York Rangers vs Boston Bruins', eventDate: null, venue: 'Madison Square Garden', city: null, quantity: 3, priceText: '$720 incl. fees', priceDollars: 720, priceBasis: 'whole_party', feeBasis: 'all_in', totalDollars: 720, section: '211', row: '8', seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'medium', unreadable: ['Image is blurred; section, row, quantity and event date are less clear.', 'Event year is not shown.'] };
class FixedReader implements ListingReader {
  readonly name = 'fixed';
  constructor(private readonly out: ListingRead) {}
  async read(): Promise<ListingRead> {
    return this.out;
  }
}

describe('a blurred screenshot is never read as fact (#151)', () => {
  it('a count the read says it couldn’t make out is asked, not stated', async () => {
    const turns = await runThread(scenario('screenshot-cheaper/blurry'), '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), listingReader: new FixedReader(blurredRead) });
    const all = turns.map((t) => t.reply).join('\n');
    expect(all).not.toMatch(/\b(?:3|three) tickets\b/i);
    expect(all).not.toMatch(/row 8/i);
    expect(all).toMatch(/how many/i);
  }, 60_000);
});

describe('side questions and a closing thanks get their own short answer (#136, #137)', () => {
  it('"is MSG easy to get to from Penn Station?" is answered on its own: no recommendation sent again', async () => {
    const [, side, next] = (await replay('side-question')) as [TurnOut, TurnOut, TurnOut];
    expect(side.newRecommendations).toBe(0);
    expect(side.emails).toHaveLength(1);
    expect(side.reply).toMatch(/Directions are outside what I check/);
    // The request carries on: the next question gets the recommendation, with no holding note before it.
    expect(next.emails.map((e) => e.cls)).toEqual(['recommendation']);
    expect(next.brief).toMatchObject({ quantity: 5, budgetCents: 50000 });
  }, 60_000);

  it('"Perfect, thanks — all set!" gets one line and no new recommendation', async () => {
    const [, close] = (await replay('thanks-close')) as [TurnOut, TurnOut];
    expect(close.newRecommendations).toBe(0);
    expect(close.emails).toHaveLength(1);
    expect(close.reply).not.toMatch(/section|\$\d/);
  }, 60_000);

  it('a holding note goes only with a real change while a person reviews the answer', async () => {
    // The eval sends drafts as written, as production does (#155); a person reviewing is this test's case.
    const reviewed = (id: string) => replay({ ...scenario(id), env: { AUTO_SEND_RECOMMENDATIONS: 'false' } });
    const [, grows] = (await reviewed('party-grows')) as [TurnOut, TurnOut];
    expect(grows.reply).toContain('Got your update: 5 tickets.');
    for (const t of await reviewed('side-question')) expect(t.reply).not.toContain('Got your note');
  }, 60_000);
});
