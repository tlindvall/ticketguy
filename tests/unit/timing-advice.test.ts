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
  it('falling prices say nothing about waiting to someone who never raised timing (live Oct 17)', () => {
    const p = buildPacket(args({}));
    // "Prices have been easing, but that doesn't tell me they'll keep falling. Whether waiting is worth it depends on…"
    // opened a reply to "How much are tickets?": an answer to a question nobody asked.
    expect(p.claimRecords.find((c) => c.id === 'C_READ')).toBeUndefined();
    expect((p.followUps ?? []).join(' ')).not.toMatch(/sorted by|lock in seats|wait for a better price/);
  });
  it('asked whether to wait, the timing questions come back', () => {
    const p = buildPacket(args({ trendAsked: { noAlerts: false, riskOk: false } }));
    expect(p.followUps).toEqual(expect.arrayContaining(['When do you need tickets sorted by, and would you rather lock in seats now or wait for a better price and risk missing out?']));
  });
  it('"How much are tickets?" is answered with the price, first, for their number (live Oct 17, Rangers vs Ducks)', async () => {
    const { validateAndRender } = await import('@/lib/advice/renderer');
    const p = buildPacket(args({ askedText: 'How much are tickets to rangers v Anaheim 2 tickets?', eventLabel: 'New York Rangers vs. Anaheim Ducks' }));
    const answer = p.claimRecords.find((c) => c.id === 'C_PRICE_ANSWER')!;
    expect(answer.text).toBe('Tickets for two start at $130 a ticket before fees, so about $260 for both, on StubHub and Vivid Seats when I checked in the last hour. Fees are added at checkout. Tell me your budget and where you’d like to sit, and I’ll pick the seats.');
    expect(p.claimRecords.find((c) => c.id === 'C_READ')).toBeUndefined();
    const r = validateAndRender(p, { decision: p.decision, opening: '', paragraphs: [{ claimIds: ['C_MARKET'], prose: '' }], closing: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.textBody.split('\n\n');
    // The answer is the first thing after the event line: no "My read", no buy-or-wait.
    expect(body[2]).toMatch(/^Tickets for two start at \$130 a ticket before fees/);
    expect(r.textBody).not.toMatch(/My read|easing|keep falling|missing out/);
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
    const trendAsked = { noAlerts: false, riskOk: false };
    expect(read(args({ trendAsked }, ctx({ reasons: ['stale_48h'] })))).not.toContain('easing');
    const lower = buildPacket(args({ seatingPreference: 'lower level' }));
    expect(lower.claimRecords.find((c) => c.id === 'C_MARKET')!.text).toContain('These cover every seat in the venue, so they don’t reflect your preference (“lower level”).');
    expect(lower.claimRecords.find((c) => c.id === 'C_READ')?.text ?? '').not.toContain('easing');
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
    // With a budget, the read is how the market sits against it (and nothing on timing they didn't raise).
    const p = buildPacket(args({ quantity: 5, eventLabel: 'Knicks vs. Celtics at Madison Square Garden, Sat, Oct 24', seatingPreference: 'No obstructed views', priorities: { mustAttend: null, waitRiskTolerance: null, decisionDeadline: null, budgetTotalCents: 50000, togetherRequired: null, splitGroupAllowed: null, watchConsentGiven: false } }));
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
    expect(parts[1]).toBe('Knicks vs. Celtics at Madison Square Garden, Sat, Oct 24 · 5 tickets · up to $500 in total');
    // The read gives the judgment against their budget, in plain words; the floor is in the market lines, said once (PW-EMAIL-FOCUS-01).
    expect(parts[2]).toMatch(/^Your budget is \$500 for five/);
    expect(parts[2]).not.toContain('$130');
    expect(r.textBody).not.toMatch(/My read|keep falling|missing out/);
    expect(parts[3]).toBe('The resale market when I last checked:');
    expect(parts[4]!.split('\n').every((l) => l.startsWith('- '))).toBe(true);
    expect(r.textBody).toContain('- These cover every seat in the venue, so they don’t reflect your preference (“no obstructed views”).');
    expect(r.textBody).not.toContain('eyeing:');
    expect(r.textBody).not.toContain('yardstick');
    expect(r.textBody).not.toContain('not only No');
    // The opener's first sentence carries the emphasis; amounts elsewhere aren't each bolded.
    expect(r.htmlBody).toMatch(/<strong>Your budget is [^<]+<\/strong>/);
    expect(r.htmlBody).not.toContain('<strong>$130</strong>');
    // The source line is the small print: 14/21 in the supporting grey (personal-email design, Oct 3).
    expect(r.htmlBody).toContain('font-size:14px;line-height:21px;color:#536174;');
  });
});
