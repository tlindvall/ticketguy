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

describe('over budget: the outcome follows the evidence and the time left, never a raised budget', () => {
  it('falling, but the game is tonight: no waiting for $200; one question instead', () => {
    const text = email(args(ctx({ direction: 'down', h72: { hours: 72, fromCents: 11000, toCents: 8469, changeCents: -2531, pct: -0.23 } }), { until: game }));
    expect(text).toContain('I haven’t found a confirmed pair under $200.');
    expect(text).toContain('Comparable pairs have fallen 23% over three days, but there isn’t time to wait for $200.');
    expect(text).toContain('Would you go up to about $220 for these, or should I look at other seats or another date?');
    expect(text).not.toMatch(/hold off|watch it/);
  });

  it('falling with weeks to go and a watch that can run: hold off and watch the target', () => {
    const later = { ...args(ctx({ direction: 'down', h72: { hours: 72, fromCents: 11000, toCents: 8469, changeCents: -2531, pct: -0.23 } }), { until: new Date('2026-10-30T16:00:00Z') }), eventStartAt: new Date('2026-10-31T23:30:00Z') } as BuildPacketArgs;
    const text = email(later);
    expect(text).toContain('I’d hold off: you don’t need to stretch your budget yet.');
    expect(text).toContain('Prices are falling. The cheapest listed pair is down 23% since three days ago. That’s the direction you need, but it’s no promise they reach $200 for two.');
    expect(text).toMatch(/Want me to watch your \$200 target\? Reply “watch it” and I’ll keep checking until Oct 30, 12:00 PM EDT and email you if listings for two come in at about \$200 or less with fees\./);
  });

  it('rising: says so, and asks rather than suggesting a wait', () => {
    const text = email(args(ctx({ direction: 'up', h72: { hours: 72, fromCents: 7000, toCents: 8469, changeCents: 1469, pct: 0.21 } }), null));
    expect(text).toContain('Prices are rising. The cheapest listed pair is up 21% since three days ago. Waiting for $200 for two hasn’t paid off so far.');
    expect(text).toContain('Would you go up to about $220');
  });

  it('no usable history: says so, and no watch is offered when one could not start', () => {
    const text = email(args(ctx({ adequacy: 'insufficient', points: 1 }), null));
    expect(text).toContain('I don’t have enough price history to expect a drop to $200.');
    expect(text).not.toMatch(/watch it/);
  });

  it('inside the budget: none of this', () => {
    const a = args(ctx({ direction: 'down', h72: { hours: 72, fromCents: 11000, toCents: 8469, changeCents: -2531, pct: -0.23 } }), { until: game });
    const fit = { ...a, priorities: { ...a.priorities, budgetTotalCents: 30000 }, picks: { ...a.picks!, ...pickListings([listing(8469, 2, '415', '4')], 2, 30000, 30)! } } as BuildPacketArgs;
    const text = email(fit);
    expect(text).not.toMatch(/watch it|price history|direction you need|haven’t found/);
  });
});

/**
 * Live, Oct 9: "This is the product". The review the same day: include the trend only when it helps answer the
 * question. Rising or falling, it's a reason and the table shows it oldest first; steady or both ways, a good option
 * within reach needs no chart.
 */
describe('how prices are moving, where it decides the advice', () => {
  const fitting = (market: MarketContext) => {
    const a = args(market, null);
    return { ...a, priorities: { ...a.priorities, budgetTotalCents: null }, picks: { ...a.picks!, ...pickListings([listing(8469, 2, '415', '4')], 2, null, 30)! } } as BuildPacketArgs;
  };
  const h24 = (from: number) => ({ hours: 24, fromCents: from, toCents: 8469, changeCents: 8469 - from, pct: (8469 - from) / from });
  const h72 = (from: number) => ({ hours: 72, fromCents: from, toCents: 8469, changeCents: 8469 - from, pct: (8469 - from) / from });

  it('rising: buy if set on going, with the rise and the table, oldest first', () => {
    const text = email(fitting(ctx({ direction: 'up', h24: h24(7920), h72: h72(7100) })));
    expect(text).toContain('I’d buy these if you’re set on going.');
    expect(text).toContain('Comparable pairs have risen 19% over three days. That supports buying; it doesn’t prove tomorrow will cost more.');
    expect(text).toContain('How prices are moving: rising\n3 days ago: $142\nYesterday: $158 (▲ $16)\nNow: $169 (▲ $11)\nThe cheapest listed pair, before fees, from StubHub and Vivid Seats.');
    expect(text).not.toContain('I haven’t checked it at checkout');
  });

  it('falling with the game tonight: buy now, waiting risks the seats', () => {
    const text = email(fitting(ctx({ direction: 'down', h24: h24(9000), h72: h72(11000) })));
    expect(text).toContain('I’d buy these now: there isn’t much time left to wait.');
    expect(text).toContain('Comparable pairs have fallen 23% over three days, but waiting means risking these seats.');
    expect(text).toContain('How prices are moving: falling');
  });

  it('steady: go for these, no chart', () => {
    const text = email(fitting(ctx({ direction: 'flat', h24: h24(8500), h72: h72(8400) })));
    expect(text).toContain('I’d go for these if checkout comes to about $220 for two.');
    expect(text).not.toContain('How prices are moving');
  });

  it('both ways: go for these, no chart', () => {
    const text = email(fitting(ctx({ direction: 'mixed', h24: h24(7700), h72: h72(8400) })));
    expect(text).toContain('I’d go for these if checkout comes to about $220 for two.');
    expect(text).not.toContain('How prices are moving');
  });

  it('no module from a series that can’t say it: too thin, stale, or broader than the seats they asked about', () => {
    expect(email(fitting(ctx({ adequacy: 'insufficient', direction: 'insufficient', points: 1 })))).not.toContain('How prices are moving');
    expect(email(fitting(ctx({ direction: 'up', h72: h72(7100), reasons: ['stale_48h'] })))).not.toContain('How prices are moving');
    const zoned = { ...fitting(ctx({ direction: 'up', h72: h72(7100) })), seatingPreference: 'lower bowl' } as BuildPacketArgs;
    expect(email(zoned)).not.toContain('How prices are moving');
  });
});
