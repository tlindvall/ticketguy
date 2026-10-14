import { describe, expect, it } from 'vitest';
import { runThread } from '../../evals/harness';
import { LONG } from '../../evals/scenarios/long';
import { FixtureExtractor, type Extractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';

/**
 * #146: "what about the nets game sunday instead" offered only "Friday, October 30: Brooklyn Nets vs. Miami Heat,
 * Barclays Center" when the day read had no Nets game. The Nets' game that Sunday is Knicks vs. Nets at the Garden,
 * where they are the visitor; the nearest-dates fallback now lists their games either side.
 */
describe('the nearest games for a team include its away games (#146)', () => {
  it('a missed day for the Nets offers Knicks vs. Nets at the Garden, not only Barclays', async () => {
    const s = LONG.find((x) => x.id === 'long/knicks-screenshot-alert')!;
    const fx = new FixtureExtractor();
    // The day pinned a week off (the model's read can't be seen; any day without a Nets game takes this path).
    const ex: Extractor = { name: 'scripted', extract: async (input) => { const r = await fx.extract(input); return /nets game sunday/.test(input.text) ? { ...r, resolvedLocalDate: '2026-11-08' } : r; } };
    const turns = await runThread({ ...s, steps: s.steps.slice(0, 8) }, '', { extractor: ex, drafter: new FixtureDrafter() });
    const reply = turns[7]!.reply;
    expect(reply).toMatch(/closest Brooklyn Nets games I have/);
    expect(reply).toMatch(/Sunday, November 1, at 6 p\.m\.: New York Knicks vs\. Brooklyn Nets, Madison Square Garden/);
  }, 60_000);
});
