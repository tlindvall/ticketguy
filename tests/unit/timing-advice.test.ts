import { describe, expect, it } from 'vitest';
import { buildPacket, type BuildPacketArgs } from '@/lib/advice/packet';
import type { MarketContext } from '@/lib/market/series';

const at = new Date('2026-10-20T12:00:00Z');
const ctx = (over: Partial<MarketContext> = {}): MarketContext => ({ methodVersion: 'm', basis: 'pair', zone: null, adequacy: 'sufficient', reasons: [], current: { priceCents: 13000, at, activeListings: 400 }, h24: null, h72: { hours: 72, fromCents: 16000, toCents: 13000, changeCents: -3000, pct: -0.19 }, direction: 'down', supply: { trend: 'stable', now: 400, before: 390, hours: 72 }, typical: null, points: 12, ...over });
const args = (over: Partial<BuildPacketArgs>, market: MarketContext = ctx()) => ({
  requestId: 'r', revision: 1, quantity: 2, eventLabel: 'x', best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
  policy: { decision: 'insufficient_evidence', reasonCodes: [], abstentions: [], nextCheckpointAt: null, waitDeadlineAt: null, watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [] },
  priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false },
  sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
  market: { basis: 'pair', context: market, supply: market.supply, supplyScope: 'all', comparableLabel: null, visible: true }, ...over,
}) as unknown as BuildPacketArgs;
const read = (a: BuildPacketArgs) => buildPacket(a).claimRecords.find((c) => c.id === 'C_READ')?.text ?? '';

describe('timing advice follows the buyer, not just the market', () => {
  it('falling prices alone are "not enough to say", with the deadline and risk asked for', () => {
    const p = buildPacket(args({}));
    expect(p.claimRecords.find((c) => c.id === 'C_READ')!.text).toContain('Whether waiting is worth it depends on when you need to decide and how much you’d mind missing out');
    expect(p.followUps).toEqual(expect.arrayContaining(['When do you need to have tickets sorted by?', 'Would you rather lock in seats now, or wait for a better price and accept you might miss out?']));
  });
  it('a buyer who can wait, with a deadline, keeps the risk and the date; venue-wide counts are not their supply', () => {
    // R2-SUPPLY-COPY-01: 400 listings across the venue say nothing about blocks of two together.
    const text = read(args({ priorities: { mustAttend: false, waitRiskTolerance: 'high', decisionDeadline: new Date('2026-10-28T00:00:00Z'), budgetTotalCents: null, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false } }));
    expect(text).toContain('I can’t see how many listings there are for a group your size, so that alone isn’t a reason to wait');
    expect(text).toContain('I’d decide by Oct 27');
    expect(text).not.toMatch(/plenty|no need to rush/);
  });
  it('someone travelling to it, or who must go, is not told to hold out', () => {
    expect(read(args({ travelling: true }))).toContain('since you can’t risk missing it, I wouldn’t hold out for a lower price');
  });
  it('stale or venue-wide figures give no trend call for the seats they asked about', () => {
    expect(read(args({}, ctx({ reasons: ['stale_48h'] })))).not.toContain('easing');
    const lower = buildPacket(args({ seatingPreference: 'lower level' }));
    expect(lower.claimRecords.find((c) => c.id === 'C_MARKET')!.text).toContain('These cover every seat in the venue, so they don’t reflect your preference (“lower level”).');
    expect(lower.claimRecords.find((c) => c.id === 'C_READ')!.text).not.toContain('easing');
  });
});

/**
 * "This needs to read better": a market-only reply was five paragraphs of block text, one of them a lead-in
 * ("That points to a simple way to judge any seats you're eyeing:") with nothing after it, and "not only No
 * obstructed views seats". It now reads answer first, the market as bullets, prices in bold.
 */
describe('the advice email reads at a glance', () => {
  it('event line, the read first, market bullets, source in small print, and no prose left hanging', async () => {
    const { validateAndRender } = await import('@/lib/advice/renderer');
    const p = buildPacket(args({ quantity: 5, eventLabel: 'Knicks vs. Celtics at Madison Square Garden, Sat, Oct 24', seatingPreference: 'No obstructed views' }));
    const blocks = {
      decision: p.decision,
      opening: 'For five together, I’d use the current resale market as the yardstick rather than force a buy call yet.',
      paragraphs: [{ claimIds: ['C_MARKET'], prose: 'Here’s the useful context:' }, { claimIds: ['C_READ'], prose: 'That points to a simple way to judge any seats you’re eyeing:' }],
      closing: 'Send me what you find.',
    };
    const r = validateAndRender(p, blocks);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parts = r.textBody.split('\n\n');
    expect(parts[1]).toBe('Knicks vs. Celtics at Madison Square Garden, Sat, Oct 24 · 5 tickets');
    // The read gives the judgment; the floor is in the market lines, said once (PW-EMAIL-FOCUS-01).
    expect(parts[2]).toMatch(/^My read: /);
    expect(parts[2]).not.toContain('$130');
    expect(parts[3]).toBe('The resale market when I last checked:');
    expect(parts[4]!.split('\n').every((l) => l.startsWith('- '))).toBe(true);
    expect(r.textBody).toContain('- These cover every seat in the venue, so they don’t reflect your preference (“no obstructed views”).');
    expect(r.textBody).not.toContain('eyeing:');
    expect(r.textBody).not.toContain('yardstick');
    expect(r.textBody).not.toContain('not only No');
    // The opener's first sentence carries the emphasis; amounts elsewhere aren't each bolded.
    expect(r.htmlBody).toMatch(/<strong>My read: [^<]+<\/strong>/);
    expect(r.htmlBody).not.toContain('<strong>$130</strong>');
    expect(r.htmlBody).toContain('font-size:13px');
  });
});
