import { describe, expect, it } from 'vitest';
import { runThread, type Scenario, type TurnOut } from '../../evals/harness';
import { AS_OF } from '../../evals/world';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';

/**
 * Eval issue #158, its simulated threads (main-21): sim/budget-dad step 2 ("is that the cheapest four together? which
 * row in 214? not the very top rows") and sim/date-night step 2 (the balcony is fine "as long as the view isn't
 * obstructed"). The replies repeated the recommendation; each part is now answered from the listings.
 */
const run = (id: string, steps: string[], now?: string, env?: Record<string, string>): Promise<TurnOut[]> => runThread({ id, capability: 'x', now, env, steps: steps.map((text) => ({ text })) } as unknown as Scenario, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter() });

describe('the cheapest, the row and the view, answered (#158)', () => {
  it('budget-dad: yes it is the cheapest four together with the full price, the cheaper one without fees named as that, and the row', async () => {
    const [, two] = (await run('budget-dad', ['Hi, I need 4 seats together for the Knicks game on Wednesday vs the Celtics, as cheap as possible but we need to sit together. Budget is $900 total.', 'Thanks! Is that the cheapest option where all 4 of us sit together? And which row is it in section 214? My son is 8 so I would rather not be in the very top rows.'], AS_OF.knicksWeek)) as [TurnOut, TurnOut];
    expect(two.reply).toContain('The seats I’d buy are in row L of section 214. The listing doesn’t say how far up row L sits in section 214, so check the seat map at checkout before you pay.');
    expect(two.reply).toContain('Yes: of the listings I can check with their full price, these are the cheapest 4 together, at $880 total including the verified charges. One more: section 209, row Q, is listed at $640 before fees, but its fees aren’t shown, so I can’t tell you its total.');
    expect(two.reply).not.toMatch(/How this compares|Checked: fixture/);
  }, 60_000);

  it('date-night: a view stated as a condition is answered, with the row, before the pick', async () => {
    const [, two] = (await run('date-night', ['Hi! Looking for 2 tickets to Hamilton on Saturday October 10, evening show, max $500 total.', 'Balcony is fine for us as long as the view is not obstructed. Can you confirm, and which row are they in?'], undefined, { SERVICE_POLICY_MODE: 'shadow' })) as [TurnOut, TurnOut];
    // Production's service depth (shadow): under enforce a show goes to the Guide, which names no seats to judge.
    expect(two.reply).toMatch(/^Hey,\n\nThe listing for section BALC, row C isn’t marked obstructed or limited view\. I leave out listings that are\./);
    expect(two.reply).toContain('My pick hasn’t changed: 2 seats together in section BALC');
  }, 60_000);
});
