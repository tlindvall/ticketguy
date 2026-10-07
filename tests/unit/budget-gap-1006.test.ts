import { describe, expect, it } from 'vitest';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { pickListings, type MarketListing } from '@/lib/market/alternatives';
import type { MarketContext } from '@/lib/market/series';

/**
 * Live, Oct 6 2026: Rangers vs Islanders tonight, two tickets, $200 budget. The brief said "Nothing for two fits your
 * $200 yet." and showed the closest pair at about $220, then nothing about which way prices were going or what we'd
 * do next. Over budget, the email now says how the price has moved for their party (or that we can't tell) and offers
 * a watch when one could actually start.
 */
const at = new Date('2026-10-06T16:00:00Z');
const game = new Date('2026-10-06T23:30:00Z');
const listing = (priceCents: number, quantity: number, section: string, row: string): MarketListing => ({ priceCents, quantity, section, row, marketplace: 'stubhub', listingId: `${section}-${row}`, zone: null } as unknown as MarketListing);
const ctx = (over: Partial<MarketContext>): MarketContext => ({ methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 8469, at: new Date(at.getTime() - 30 * 60_000), activeListings: 40 }, h24: null, h72: null, direction: 'insufficient', supply: { trend: 'unknown', now: 40, before: null, hours: null }, typical: null, points: 12, ...over });
const args = (market: MarketContext | null, watchOffer: { until: Date } | null) => {
  const chosen = pickListings([listing(8469, 2, '415', '4'), listing(9500, 2, '420', '9')], 2, 20000, 30)!;
  return {
    requestId: 'r', revision: 1, quantity: 2, eventLabel: 'New York Rangers vs. New York Islanders at Madison Square Garden, Tonight', eventParts: { title: 'New York Rangers vs. New York Islanders', where: 'Madison Square Garden, New York', when: 'Tue, Oct 6, 7:30 PM EDT' }, eventStartAt: game, headerStartAt: game, timeZone: 'America/New_York', eventCategory: 'nhl', eventNoun: 'game',
    best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
    policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
    priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: 20000, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
    sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    market: { basis: 'pair', context: market, supply: market?.supply ?? { trend: 'unknown', now: null, before: null, hours: null }, supplyScope: 'group', comparableLabel: 'New York Rangers', visible: true },
    picks: { ...chosen, age: 'recent', links: [{ label: 'Search StubHub for this game', url: 'https://www.stubhub.com/secure/search?q=rangers' }] },
    watchOffer,
  } as unknown as BuildPacketArgs;
};
const email = (a: BuildPacketArgs) => {
  const p = buildPacket(a);
  const r = validateAndRender(p, { decision: p.decision, opening: '', paragraphs: [{ claimIds: [], prose: '' }], closing: '' });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.textBody;
};

describe('over budget: which way the price is going, and a watch when one can run', () => {
  it('falling: says the fall and that it is no promise, then offers the watch until the game', () => {
    const text = email(args(ctx({ direction: 'down', h72: { hours: 72, fromCents: 11000, toCents: 8469, changeCents: -2531, pct: -0.23 } }), { until: game }));
    expect(text).toContain('Nothing for two fits your $200 yet.');
    expect(text).toContain('Listed resale prices for two or more tickets have fallen from $110 to $84.69 a ticket over the last three days (before fees). That’s the direction you need, but it doesn’t mean they’ll keep falling to $200 for two.');
    expect(text).toMatch(/If \$200 for two is firm, reply “watch it” and I’ll keep checking until Oct 6, 7:30 PM EDT and email you if listings for two come in at about \$200 or less with fees\./);
  });

  it('rising: says waiting has not been paying off', () => {
    const text = email(args(ctx({ direction: 'up', h72: { hours: 72, fromCents: 7000, toCents: 8469, changeCents: 1469, pct: 0.21 } }), null));
    expect(text).toContain('have risen from $70 to $84.69 a ticket over the last three days (before fees), so waiting for $200 for two hasn’t been paying off so far.');
  });

  it('no usable history: says so, and no watch is offered when one could not start', () => {
    const text = email(args(ctx({ adequacy: 'insufficient', points: 1 }), null));
    expect(text).toContain('I don’t have enough price history for this game yet to say whether prices are heading toward $200 for two.');
    expect(text).not.toMatch(/watch it/);
  });

  it('inside the budget: none of this', () => {
    const a = args(ctx({ direction: 'down', h72: { hours: 72, fromCents: 11000, toCents: 8469, changeCents: -2531, pct: -0.23 } }), { until: game });
    const fit = { ...a, priorities: { ...a.priorities, budgetTotalCents: 30000 }, picks: { ...a.picks!, ...pickListings([listing(8469, 2, '415', '4')], 2, 30000, 30)! } } as BuildPacketArgs;
    const text = email(fit);
    expect(text).not.toMatch(/watch it|price history|direction you need/);
  });
});

describe('the ticket brief card carries the event’s own artwork (brand assets, #116) when it has approved art', () => {
  const a = args(ctx({ direction: 'down', h72: { hours: 72, fromCents: 11000, toCents: 8469, changeCents: -2531, pct: -0.23 } }), null);
  const render = (art: Parameters<typeof validateAndRender>[2] extends infer O ? O extends { brief?: infer B } ? B : never : never) => {
    const p = buildPacket(a);
    const r = validateAndRender(p, { decision: p.decision, opening: '', paragraphs: [{ claimIds: [], prose: '' }], closing: '' }, { brief: art });
    if (!r.ok) throw new Error(r.errors.join('; '));
    return r;
  };
  it('a matchup: both teams in their colours, VS between them, on the card above the event', () => {
    const r = render({ label: 'NHL', art: { kind: 'matchup', left: { name: 'New York Rangers', shortName: 'NYR', color: '#0038a8', textColor: '#ffffff', logoUrl: null }, right: { name: 'New York Islanders', shortName: 'NYI', color: '#00539b', textColor: '#ffffff', logoUrl: null } } });
    expect(r.htmlBody).toContain('bgcolor="#0038a8"');
    expect(r.htmlBody).toContain('>NYR</div>');
    expect(r.htmlBody).toContain('>VS</td>');
    expect(r.htmlBody.indexOf('>VS</td>')).toBeLessThan(r.htmlBody.indexOf('New York Rangers vs. New York Islanders</h2>'));
    // Decoration only: the plain text is the same with or without it.
    expect(r.textBody).toBe(render(null).textBody);
  });
  it('no approved art: no artwork row, no image', () => {
    expect(render({ label: 'NHL', art: null }).htmlBody).not.toMatch(/<img|>VS</);
  });
});
