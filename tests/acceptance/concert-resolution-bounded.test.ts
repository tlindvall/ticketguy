import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { RequestExtractionSchema } from '@/lib/domain/types';
import { NO_CONSTRAINTS } from '@/lib/domain/event-constraints';
import { openTestDb, makeConcierge } from '../harness';

let h: DbHandle;
beforeAll(async () => {
  h = await openTestDb();
  await h.db.insert(t.events).values({ name: 'Dua Lipa fixture concert', category: 'concert', primaryEntityId: FX.entities.duaLipa, venueId: FX.venues.msg, localStartAt: new Date('2026-10-09T00:00:00Z'), status: 'scheduled', isFixture: true });
});
afterAll(async () => { await h.close(); });

it('an impossible concert venue stops after one alternative lookup instead of occupying the dispatcher indefinitely', async () => {
  const c = makeConcierge(h);
  const original = c.resolveEvent.bind(c);
  const calls = vi.spyOn(c, 'resolveEvent').mockImplementation(async (...args) => {
    if (calls.mock.calls.length > 3) throw new Error('unbounded alternative lookup');
    return original(...args);
  });
  const brief = RequestExtractionSchema.parse({ intent: 'new_search', eventName: null, performerOrTeam: 'Dua Lipa', city: 'New York', state: null, dateExpression: null, resolvedLocalDate: null, quantity: 2, budgetCents: null, budgetBasis: null, seatingPreference: null, togetherRequired: null, accessibilityNeeds: null, alternativesAllowed: null, submittedUrls: [], evidence: [], ambiguities: [] });
  const result = await c.resolveEvent(brief, undefined, { ...NO_CONSTRAINTS, venueTerms: ['metlife stadium'], linkedEventIds: [] });
  expect(result).toMatchObject({ kind: 'no_match', reason: 'constraint_conflict', conflict: { suggestion: null } });
  expect(calls.mock.calls.length).toBe(2);
});
