import { describe, expect, it } from 'vitest';
import { runThread, type Scenario, type TurnOut } from '../../evals/harness';
import { CORE } from '../../evals/scenarios/core';
import { FAMILIES } from '../../evals/scenarios/families';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';

/**
 * Eval issue #155 (45 threads): an acknowledgment went out seconds before the answer it announced. Production sends
 * drafts as written, so what the acknowledgment said (what we assumed) belongs in the answer; with a person reviewing,
 * the wait is real and the acknowledgment still goes.
 */
const scenario = (id: string): Scenario => [...CORE, ...FAMILIES].find((x) => x.id === id)!;
const replay = (s: Scenario): Promise<TurnOut[]> => runThread(s, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter() });

describe('one email per customer message (#155)', () => {
  it.each(['side-question', 'rangers-this-thursday/clean', 'party-grows', 'switch-team', 'nickname-knicks/messy-typo'])('%s: every message gets one email', async (id) => {
    for (const t of await replay(scenario(id))) expect(t.emails.map((e) => e.cls)).toHaveLength(Math.min(1, t.emails.length));
  }, 60_000);

  it('what we assumed is said in the answer, under the event', async () => {
    const [first] = (await replay(scenario('side-question'))) as [TurnOut];
    expect(first.emails.map((e) => e.cls)).toEqual(['recommendation']);
    const text = first.emails[0]!.text;
    expect(text).toContain('I\'ve gone with the next home game, Saturday, October 3. Tell me if you meant a different one.');
    expect(text.indexOf('next home game')).toBeGreaterThan(text.indexOf('5 tickets · up to $500 in total'));
    expect(first.emails[0]!.html).toMatch(/ve gone with the next home game/);
  }, 60_000);

  it('with a person reviewing, the acknowledgment still says it while they wait', async () => {
    const [first] = (await replay({ ...scenario('side-question'), env: { AUTO_SEND_RECOMMENDATIONS: 'false' } })) as [TurnOut];
    expect(first.emails.map((e) => e.cls)).toEqual(['acknowledgment', 'recommendation']);
    expect(first.emails[0]!.text).toContain('next home game');
    expect(first.emails[1]!.text).not.toContain('next home game');
  }, 60_000);
});
