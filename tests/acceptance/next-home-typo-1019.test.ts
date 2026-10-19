import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { runThread, type Scenario } from '../../evals/harness';
import { EV } from '../../evals/world';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { spellCommon } from '@/lib/domain/spelling';
import { eventConstraints } from '@/lib/domain/event-constraints';

/**
 * Live, Oct 19: "when is the nest home game for the giants?" got "Giants tickets nest home game. Got it." and "Which
 * game: Thu, Nov 12 … or Sun, Nov 22 …, and how many tickets?". "nest" is "next": the answer is the next home game.
 */
describe('typos in the words the readers key on (live Oct 19)', () => {
  it('"nest home game" is the next home game; a real nest stays a nest', () => {
    expect(spellCommon('when is the nest home game for the giants?')).toBe('when is the next home game for the giants?');
    expect(spellCommon('Nxt game?')).toBe('Next game?');
    expect(spellCommon('a bird’s nest egg')).toBe('a bird’s nest egg');
    expect(spellCommon('2 tix for tonite, hoem game')).toBe('2 tickets for tonight, home game');
    expect(spellCommon('two tickest togehter this weeekend')).toBe('two tickets together this weekend');
    // Real words one keystroke away are left alone.
    expect(spellCommon('paying for tickets')).toBe('paying for tickets');
    expect(eventConstraints(['when is the nest home game for the giants?'], { receivedAt: new Date('2026-10-19T13:38:00Z'), timeZone: 'America/New_York', venues: [] }).next).toBe(true);
  });

  it('with two home games coming up, the reply names the next one instead of asking which', async () => {
    const scenario = {
      id: 'giants-nest', capability: 'x', now: '2026-09-30T13:38:00Z',
      // A second Giants home game after the first, as in production (two games offered back).
      seed: async (db: Parameters<NonNullable<Scenario['seed']>>[0]) => {
        const [e] = await db.select().from(t.events).where(eq(t.events.id, EV.giantsCowboys));
        await db.insert(t.events).values({ ...e!, id: '7e7e0000-0000-4000-8000-000000000999', name: 'New York Giants vs. Washington Commanders', localStartAt: new Date('2026-10-18T17:00:00Z') });
      },
      steps: [{ text: 'when is the nest home game for the giants?' }],
    } as unknown as Scenario;
    const [turn] = await runThread(scenario, '', { extractor: new FixtureExtractor(), drafter: new FixtureDrafter() });
    expect(turn!.reply).toContain('The next one is New York Giants vs. Dallas Cowboys at MetLife Stadium');
    expect(turn!.reply).not.toMatch(/Which game|nest|Got it/);
  }, 60_000);
});
