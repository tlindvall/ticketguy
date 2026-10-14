import { describe, expect, it } from 'vitest';
import { runThread, type Scenario, type TurnOut } from '../../evals/harness';
import { CORE } from '../../evals/scenarios/core';
import { FAMILIES } from '../../evals/scenarios/families';
import { LONG } from '../../evals/scenarios/long';
import { AS_OF, EV } from '../../evals/world';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';

/**
 * The eval threads behind issues #135, #142, #143, #144, #145 and #146, run through the real pipeline and the eval world
 * with the rules reader in place of the model (no API key). The eval with the model is what proves them; this keeps the
 * routing from coming back.
 */
const rules = () => ({ extractor: new FixtureExtractor(), drafter: new FixtureDrafter() });
const scenario = (id: string) => [...CORE, ...FAMILIES, ...LONG].find((s) => s.id === id)!;
const run = (s: Scenario) => runThread(s, '', rules());
const upTo = (s: Scenario, n: number): Scenario => ({ ...s, steps: s.steps.slice(0, n) });
const PARKED = /couldn’t finish this one automatically/;

describe('eval issues, Oct 14', () => {
  it('#135: the Islanders game, and the earlier one, are picked from the games offered, never searched again', async () => {
    for (const id of ['pick-by-opponent', 'pick-earlier-one', 'pick-by-date']) {
      const out = await run(scenario(id));
      expect(out[1]!.eventId, id).toBe(scenario(id).steps[1]!.expect!.eventId);
      expect(out[1]!.reply).not.toMatch(/Which game|don't have a scheduled|haven’t found one that fits/);
    }
  }, 120_000);

  it('#143: "the week of Jan 12", in every phrasing, is Mon Jan 11 to Sun Jan 17, more than one league', async () => {
    for (const id of ['la-sports-week/clean', 'la-sports-week/messy', 'la-sports-week/messy-short', 'la-sports-week/messy-typo']) {
      const [first] = await run(scenario(id));
      expect(first!.reply, id).toMatch(/Jan 11 to 17/);
      expect(first!.reply, id).toMatch(/Lakers|Clippers/);
      expect(first!.reply, id).toMatch(/Kings|Rams/);
      expect(first!.reply, id).not.toMatch(/Jan 9\b|Jan 4|New York/);
    }
  }, 120_000);

  it('#144: "the lakers one on tuesday" is the listed Jan 12 game, then the party and the week carry on, nothing parked', async () => {
    const s = scenario('long/la-january-discovery');
    const out = await run(upTo(s, 5));
    expect(out[1]!.eventId).toBe(EV.lakersWarriors);
    expect(out[1]!.reply).not.toMatch(/January 5|Jan 5/);
    expect(out[2]!.eventId).toBe(EV.lakersWarriors);
    expect(out[2]!.brief?.quantity).toBe(2);
    expect(out[3]!.eventId).toBe(EV.lakersWarriors);
    // "The kings game that week": the week of the Lakers game, so Thu Jan 14's Kings game, not Sat Jan 9's.
    expect(out[4]!.eventId).toBe(EV.kingsDucks);
    expect(out.some((o: TurnOut) => PARKED.test(o.reply))).toBe(false);
  }, 180_000);

  it('#146: "the nets game sunday" is Knicks vs Nets; "stick with celtics" goes back to Knicks vs Celtics', async () => {
    const s = scenario('long/knicks-screenshot-alert');
    const out = await run(upTo(s, 9));
    expect(out[7]!.eventId).toBe(EV.knicksNets);
    expect(out[7]!.brief?.quantity).toBe(2);
    expect(out[8]!.eventId).toBe(EV.knicksCeltics);
    expect(out[8]!.reply).not.toMatch(/don't have a scheduled Boston Celtics/);
  }, 240_000);

  it('#145: "whichever is cheapest" compares both games for two and settles the cheaper, with its link', async () => {
    const out = await run({ id: 'impatient-texter-scripted', capability: 'recommendation', now: AS_OF.rangersWeek, steps: [{ text: 'yo need 2 tix to a rangers home game this week, whichever is cheapest, send a buy link pls' }] });
    expect(out[0]!.eventId).toBe(EV.rangersBruins);
    expect(out[0]!.reply).toMatch(/Cheapest for two: New York Rangers vs\. Boston Bruins on Thu, Oct 22, \$260 in total including the verified charges, against \$300 for New York Rangers vs\. New Jersey Devils on Sat, Oct 24\./);
    expect(out[0]!.reply).toMatch(/Link: https:\/\/example\.invalid\/fixture\/rb-2-/);
    expect(out[0]!.reply).not.toMatch(/Which game|can’t rank them on price/);
  }, 120_000);

  it('#142: five tickets are the together block in 211, never the split block in 310 called "together"', async () => {
    const [first] = await run(scenario('rangers-this-thursday/clean'));
    expect(first!.reply).toMatch(/5 seats together in section 211: \$640 total/);
    expect(first!.reply).not.toMatch(/together in section 310/);
  }, 120_000);

  it('"what about saturday\'s game instead?" moves to Saturday; "go back to thursday" moves back', async () => {
    const s = scenario('long/rangers-group-saga');
    const out = await run(s);
    const at = (text: string) => out.find((o) => o.customer.startsWith(text))!;
    expect(at("what about saturday's game instead?").eventId).toBe(EV.rangersDevils);
    expect(at('nah go back to thursday').eventId).toBe(EV.rangersBruins);
    expect(at('nah go back to thursday').brief?.quantity).toBe(5);
  }, 300_000);
});
