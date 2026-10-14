import { describe, expect, it } from 'vitest';
import { bringsNothingNew, closingOnly, gettingThereAsked } from '@/lib/intake/asides';
import type { RequestExtraction } from '@/lib/domain/types';

/** #136: a closing thanks and a side question mid-request got the whole recommendation again. */
describe('closing messages', () => {
  it.each(['Perfect, thanks — all set!', 'thanks!', 'Great, thank you so much', 'Got it, cheers', 'ok thx', 'Thanks for the help!\nTobias', 'all good, appreciate it 🙏'])('"%s" closes', (s) => expect(closingOnly(s)).toBe(true));
  it.each(['thanks! which seats would you go for?', 'Thanks, make it 4 tickets', 'thanks, the second one', 'Great. So which seats would you go for?', 'Perfect, can you check Saturday too', 'thanks, we bought them'])('"%s" does not', (s) => expect(closingOnly(s)).toBe(false));
});

describe('getting-there questions', () => {
  it.each(['Quick question — is MSG easy to get to from Penn Station?', 'how do we get to the arena from our hotel?', 'Is it easy to walk to the stadium from the subway?'])('"%s" is about directions', (s) => expect(gettingThereAsked(s)).toBe(true));
  it.each(['Is there parking near the stadium?', 'Need 2 tickets, and how do we get there?', 'Are these good seats?'])('"%s" is not', (s) => expect(gettingThereAsked(s)).toBe(false));
});

describe('bringsNothingNew', () => {
  const brief = (over: Partial<RequestExtraction>) => ({ quantity: 5, budgetCents: 50000, dateExpression: null, resolvedLocalDate: null, seatingPreference: null, performerOrTeam: 'Rangers', eventName: null, quotedPriceCents: null, submittedUrls: [], ...over }) as unknown as RequestExtraction;
  it('a message with no new detail changes nothing; a new count or budget does', () => {
    expect(bringsNothingNew(brief({ quantity: null, budgetCents: null, performerOrTeam: null }), brief({}), false)).toBe(true);
    expect(bringsNothingNew(brief({ quantity: 4 }), brief({}), false)).toBe(false);
    expect(bringsNothingNew(brief({ budgetCents: 60000 }), brief({}), false)).toBe(false);
    expect(bringsNothingNew(brief({}), brief({}), true)).toBe(false);
  });
});
