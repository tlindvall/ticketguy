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
  it('falling: the fall above the card and in the module, against their target, then the watch until the game', () => {
    const text = email(args(ctx({ direction: 'down', h72: { hours: 72, fromCents: 11000, toCents: 8469, changeCents: -2531, pct: -0.23 } }), { until: game }));
    expect(text).toContain('Nothing for two fits your $200 yet.');
    expect(text).toContain('over your budget. Listed prices are down $25.31 a ticket in three days.\n');
    expect(text).toContain('How prices are moving: falling\nNow: $84.69 a ticket\n3 days ago: $110, down $25.31 (23%) since\nThat’s the direction you need, but it’s no promise they reach $200 for two.');
    // Said once: the module carries it, so the old trend paragraph is gone.
    expect(text).not.toContain('Listed resale prices');
    expect(text).toMatch(/If \$200 for two is firm, reply “watch it” and I’ll keep checking until Oct 6, 7:30 PM EDT and email you if listings for two come in at about \$200 or less with fees\./);
  });

  it('rising: says waiting has not paid off', () => {
    const text = email(args(ctx({ direction: 'up', h72: { hours: 72, fromCents: 7000, toCents: 8469, changeCents: 1469, pct: 0.21 } }), null));
    expect(text).toContain('Listed prices are up $14.69 a ticket in three days.');
    expect(text).toContain('3 days ago: $70, up $14.69 (21%) since\nWaiting for $200 for two hasn’t paid off so far.');
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

/**
 * Live, Oct 9: "This is the product: the fact that tickets are going up means you need to act now." Whenever the series
 * can say it, the brief shows now, a day ago and three days ago with the exact difference, the same template whichever
 * way it moved. Past movement only: never a forecast.
 */
describe('how prices are moving, on every price lead', () => {
  const fitting = (market: MarketContext) => {
    const a = args(market, null);
    return { ...a, priorities: { ...a.priorities, budgetTotalCents: null }, picks: { ...a.picks!, ...pickListings([listing(8469, 2, '415', '4')], 2, null, 30)! } } as BuildPacketArgs;
  };
  const h24 = (from: number) => ({ hours: 24, fromCents: from, toCents: 8469, changeCents: 8469 - from, pct: (8469 - from) / from });
  const h72 = (from: number) => ({ hours: 72, fromCents: from, toCents: 8469, changeCents: 8469 - from, pct: (8469 - from) / from });

  it('rising: the rise first, both windows with the exact difference, and what it has cost two of them', () => {
    const text = email(fitting(ctx({ direction: 'up', h24: h24(7920), h72: h72(7100) })));
    expect(text).toContain('That’s the lowest listing I can see for two tickets: Section 415, Row 4 on StubHub. Listed prices are up $13.69 a ticket in three days.\n');
    expect(text).toContain('How prices are moving: rising\nNow: $84.69 a ticket\n1 day ago: $79.20, up $5.49 (7%) since\n3 days ago: $71, up $13.69 (19%) since\nFor two, that’s $27.38 more than three days ago. Waiting has cost money so far.\nCheapest listed price for two or more tickets, a ticket before fees, from StubHub and Vivid Seats.');
    expect(text).not.toContain('I haven’t checked it at checkout');
  });

  it('falling: the fall, and that it is no promise', () => {
    const text = email(fitting(ctx({ direction: 'down', h24: h24(9000), h72: h72(11000) })));
    expect(text).toContain('Listed prices are down $25.31 a ticket in three days.');
    expect(text).toContain('How prices are moving: falling');
    expect(text).toContain('For two, that’s $50.62 less than three days ago. That’s no promise they keep falling, and the seats you want could go.');
  });

  it('steady: held, and no fall to wait for', () => {
    const text = email(fitting(ctx({ direction: 'flat', h24: h24(8500), h72: h72(8400) })));
    expect(text).toContain('Listed prices have held at about $84.69 a ticket for three days.');
    expect(text).toContain('How prices are moving: steady\nNow: $84.69 a ticket\n1 day ago: $85, about the same as now, down $0.31 since\n3 days ago: $84, about the same as now, up $0.69 since\nNo fall to wait for so far.');
  });

  it('both ways: each window said, no clear fall', () => {
    const text = email(fitting(ctx({ direction: 'mixed', h24: h24(7700), h72: h72(8400) })));
    expect(text).toContain('Listed prices are up $7.69 a ticket since yesterday but about the same as three days ago.');
    expect(text).toContain('How prices are moving: up and down');
    expect(text).toContain('They’ve gone both ways, so there’s no clear fall to wait for.');
  });

  it('no module from a series that can’t say it: too thin, stale, or broader than the seats they asked about', () => {
    expect(email(fitting(ctx({ adequacy: 'insufficient', direction: 'insufficient', points: 1 })))).not.toContain('How prices are moving');
    expect(email(fitting(ctx({ direction: 'up', h72: h72(7100), reasons: ['stale_48h'] })))).not.toContain('How prices are moving');
    const zoned = { ...fitting(ctx({ direction: 'up', h72: h72(7100) })), seatingPreference: 'lower bowl' } as BuildPacketArgs;
    expect(email(zoned)).not.toContain('How prices are moving');
  });
});

