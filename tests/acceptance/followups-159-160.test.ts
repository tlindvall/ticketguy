import { describe, expect, it } from 'vitest';
import { runThread, type Scenario, type TurnOut } from '../../evals/harness';
import { CORE } from '../../evals/scenarios/core';
import { LONG } from '../../evals/scenarios/long';
import { acrossThread } from '../../evals/scorers';
import { EV } from '../../evals/world';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import type { ListingRead, ListingReader } from '@/lib/ai/listing-evidence';
import { ACROSS_GAMES, OPTIONS_ASKED } from '@/lib/intake/pipeline';

/**
 * Eval issues #159 (long threads lose coherence) and #160 (a reply repeats the one before). A follow-up about seats
 * already sent is answered, with the pick in one line, not the whole recommendation again; "what are the options?",
 * "anything cheaper together?" and "the best value of the three?" each get their own answer.
 */
const scenario = (id: string): Scenario => [...CORE, ...LONG].find((x) => x.id === id)!;
const replay = (s: Scenario, listingReader?: ListingReader): Promise<TurnOut[]> => runThread(s, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), listingReader });
const at = (turns: TurnOut[], step: number) => turns.find((t) => t.step === step)!;
type Scored = { name: string; score: number | null; metadata?: unknown };
const repeats = (s: Scenario, out: TurnOut[]) => (acrossThread.map((f) => (f as unknown as (a: unknown) => Scored)({ input: s, output: out, expected: undefined, metadata: {} })).find((r) => r.name === 'no_repeated_reply')!);

describe('a follow-up about seats already sent is answered short (#160)', () => {
  it('"so which seats would you go for?" lists the options with the pick marked, not the recommendation again', async () => {
    const s = scenario('side-question');
    const out = await replay(s);
    const t = at(out, 3);
    expect(t.emails.map((e) => e.cls)).toEqual(['recommendation']);
    expect(t.reply).toContain('Your options for 5, including the verified charges:');
    expect(t.reply).toContain('5 seats in section 224: $410 total ($82 each) (my pick).');
    expect(t.reply).not.toMatch(/How this compares|Checked: fixture/);
    // Still an answer with the brief's design: the event on its card under the headline (#76).
    expect(t.emails[0]!.html).toMatch(/border-radius:12px;border-collapse:separate/);
    expect(repeats(s, out).score).toBe(1);
  }, 60_000);

  it('"do you think prices go up before wednesday?" is the trend answer and the pick in one line; their old screenshot is not judged again', async () => {
    const shot: ListingRead = { kind: 'checkout', sensitiveContent: false, seller: 'SeatGeek', eventName: 'Boston Celtics at New York Knicks', eventDate: '2026-10-28', venue: 'Madison Square Garden', city: 'New York', quantity: 2, priceText: '$240 each incl. fees', priceDollars: 240, priceBasis: 'per_ticket', feeBasis: 'all_in', totalDollars: 480, section: '210', row: 'J', seatNumbers: null, seatsTogether: null, restrictions: [], deliveryText: null, deliveryBy: null, includedBenefits: [], confidence: 'high', unreadable: [] };
    const s = scenario('long/knicks-screenshot-alert');
    const out = await replay(s, { name: 'fixed', read: async () => shot });
    expect(at(out, 2).reply).toMatch(/SeatGeek/);
    const t = at(out, 3);
    expect(t.reply).toMatch(/^Hey,\n\nOn buy or wait: /);
    expect(t.emails[0]!.html).toMatch(/border-radius:12px;border-collapse:separate/);
    expect(t.reply).toContain('My pick hasn’t changed: 2 seats together in section 210: $420 total');
    expect(t.reply).not.toMatch(/SeatGeek|screenshot/i);
    expect(repeats(s, out).score).toBe(1);
  }, 120_000);
});

describe('each question in a long thread gets its own answer (#159)', () => {
  it('"anything cheaper where we still sit together?" names the cheapest five together and what it costs over', async () => {
    const t = at(await replay(scenario('long/rangers-group-saga')), 6);
    expect(t.reply).toContain('Nothing for 5 together fits inside your $600: the cheapest 5 together I can see are in section 211, $640 total ($128 each) including the verified charges, $40 over.');
    expect(t.reply).not.toMatch(/haven’t been able to check|I don’t have seats to recommend yet that meet/);
    expect(t.reply).not.toMatch(/310[^\n]*together/);
  }, 120_000);

  it('"which is the best value of the three for 2 of us?" compares the three games; "go with the kings" is that Kings game', async () => {
    const s = scenario('long/la-january-discovery');
    const out = await replay(s);
    const nine = at(out, 9);
    expect(nine.emails.map((e) => e.cls)).toEqual(['clarification']);
    expect(nine.reply).toContain('On price for two, the best value is Los Angeles Kings vs. Anaheim Ducks on Thu, Jan 14: $140 in total including the verified charges, against $160 for Los Angeles Clippers vs. Phoenix Suns on Wed, Jan 13; $380 for Los Angeles Lakers vs. Golden State Warriors on Tue, Jan 12.');
    expect(nine.eventId).toBe(EV.clippersSuns);
    const ten = at(out, 10);
    expect(ten.eventId).toBe(EV.kingsDucks);
    expect(ten.reply).toMatch(/kd-2-upper-301/);
    expect(repeats(s, out).score).toBe(1);
  }, 120_000);

  it('reads the asks', () => {
    for (const t of ['which is the best value of the three for 2 of us?', 'which of the two is cheaper?', 'which one of the three is the best deal']) expect(ACROSS_GAMES.test(t)).toBe(true);
    for (const t of ['cheapest seats please', '2 cheap tickets thursday']) expect(ACROSS_GAMES.test(t)).toBe(false);
    for (const t of ['ok so what are the options for the 5 of us?', 'Great. So which seats would you go for?', 'ok just tell me which one to buy']) expect(OPTIONS_ASKED.test(t)).toBe(true);
    for (const t of ['what are the odds', 'any options under $300?']) expect(OPTIONS_ASKED.test(t)).toBe(false);
  });
});
