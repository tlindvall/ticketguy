import { describe, expect, it } from 'vitest';
import { buildPacket, recheckWhen, type BuildPacketArgs } from '@/lib/advice/packet';
import { validateAndRender } from '@/lib/advice/renderer';
import { renderTemplate } from '@/lib/email/templates';
import { revisionNote } from '@/lib/intake/pipeline';
import type { RequestExtraction } from '@/lib/domain/types';

/**
 * What the customer hears between the decision and the next step, from the CTO audit of Oct 10: the recheck point
 * printed as an ISO timestamp (gap 22), alerts and refusals without a greeting or the event (gap 37), the
 * "we never buy, hold or resell" line missing from every auto-approved reply (brief: not a marketplace), and the
 * one-line note when a later message re-opens an answer still waiting for review (gap 3).
 */
const ctx = { appUrl: 'https://app.example', postalAddress: null };
const at = new Date('2026-10-14T16:00:00Z');

describe('the recheck point, in the venue’s time (audit gap 22)', () => {
  it('says a weekday, month, day and the nearest hour, never an ISO timestamp', () => {
    expect(recheckWhen(new Date('2026-10-15T22:00:00Z'), 'America/New_York')).toBe('Thursday, Oct 15, around 6pm');
    expect(recheckWhen(new Date('2026-10-15T22:20:00Z'), 'America/Chicago')).toBe('Thursday, Oct 15, around 5pm');
    expect(recheckWhen(new Date('2026-10-15T16:05:00Z'), 'America/New_York')).toBe('Thursday, Oct 15, around noon');
    // 11:45pm rounds to midnight, which is the next day.
    expect(recheckWhen(new Date('2026-10-16T03:45:00Z'), 'America/New_York')).toBe('Friday, Oct 16, around midnight');
    expect(recheckWhen(new Date('2026-10-15T22:00:00Z'), 'America/Los_Angeles', false)).toBe('Thursday, Oct 15');
  });

  it('C_CHECKPOINT reads as a day and an hour in the first person, and offers no watch that isn’t running', () => {
    const a = {
      requestId: 'r', revision: 1, quantity: 2, eventLabel: 'New York Rangers vs. New Jersey Devils at Madison Square Garden', eventStartAt: new Date('2026-10-24T23:00:00Z'), headerStartAt: new Date('2026-10-24T23:00:00Z'), timeZone: 'America/New_York', eventCategory: 'nhl', eventNoun: 'game',
      best: null, alternatives: [], entryReference: null, benchmark: null, benchmarkRunId: null, trend: null, trendRunId: null,
      policy: { decision: 'wait_and_recheck', reasonCodes: [], abstentions: [], nextCheckpointAt: new Date('2026-10-15T22:00:00Z'), waitDeadlineAt: new Date('2026-10-16T23:10:00Z'), watchScheduled: false, stopConditions: [], policyVersion: 'p', clarificationNeeded: [], priceAttractiveness: 'unknown' },
      priorities: { mustAttend: false, waitRiskTolerance: 'high', decisionDeadline: null, budgetTotalCents: 40000, togetherRequired: true, splitGroupAllowed: false, watchConsentGiven: false },
      sourcesChecked: [], sourcesUnavailable: [], independentOptionCount: 0, observedAt: at, evidenceExpiresAt: null, basketKey: 'b', watchConsentReference: null, isFixture: false,
    } as unknown as BuildPacketArgs;
    const p = buildPacket(a);
    const claim = p.claimRecords.find((c) => c.id === 'C_CHECKPOINT')!;
    expect(claim.text).toBe('Look again on Thursday, Oct 15, around 6pm, and decide by Friday, Oct 16, around 7pm at the latest. I’m not watching this for you automatically, so check back then.');
    expect(claim.text).not.toMatch(/\d{4}-\d{2}-\d{2}T|We |us to/);
    const r = validateAndRender(p, { decision: p.decision, opening: '', paragraphs: [{ claimIds: ['C_CHECKPOINT'], prose: 'What I would do next:' }], closing: '' });
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(r.textBody).toContain('Look again on Thursday, Oct 15, around 6pm');
    expect(r.textBody).not.toMatch(/Z\b|T\d{2}:\d{2}/);
  });
});

describe('every reply says we are not a marketplace (brief)', () => {
  it('the automated footer carries the same plain sentence as the reviewed one', () => {
    for (const r of [renderTemplate('raw_auto', { text: 'advice', html: '<p>advice</p>' }, ctx), renderTemplate('acknowledgment', { eventLabel: 'the Rangers game', knownFacts: [] }, ctx), renderTemplate('off_topic', {}, ctx)]) {
      expect(r.text).toContain('AI-assisted ticket advice. We never buy, hold or resell tickets.');
      expect(r.html).toContain('We never buy, hold or resell tickets.');
      expect(r.text).not.toContain('human-reviewed');
    }
    expect(renderTemplate('raw', { text: 'advice', html: '<p>advice</p>' }, ctx).text).toContain('we never buy, hold or resell tickets');
  });
});

describe('alerts and refusals in the house voice (audit gap 37)', () => {
  it('a seller watch alert greets, names the event, and keeps every fact and disclosure', () => {
    const r = renderTemplate('watch_alert', { quantity: 2, section: '112', totalCents: 43000, observedAt: 'Oct 14, 12:00 PM EDT', url: 'https://x.test/o', eventLabel: 'New York Rangers vs. New Jersey Devils at Madison Square Garden' }, ctx);
    expect(r.text).toMatch(/^Hey,\n\nI’ve found a verified option for New York Rangers vs\. New Jersey Devils at Madison Square Garden: 2 together in section 112, now \$430 total \(checked Oct 14, 12:00 PM EDT\)\./);
    expect(r.text).toContain('If you want them, here’s the listing: https://x.test/o');
    expect(r.text).toContain('Prices can change before checkout, so check the total before you pay. Reply "stop" to end this watch.');
    expect(r.text).toContain('AI-assisted and human-reviewed');
    expect(r.html).toContain('href="https://x.test/o"');
    // The body speaks for itself; only the shared footer says "we" for the service.
    expect(r.text.split('\n\n').slice(0, 4).join('\n\n')).not.toMatch(/\bWe\b|Link:/);
  });

  it('a refusal greets, speaks for itself, names the event when we know it, and says what to do', () => {
    const r = renderTemplate('unsupported', { reason: 'That event is outside the US, and we only cover US events for now.', what: 'Hamilton' }, ctx);
    expect(r.text).toMatch(/^Hey,\n\nThat event is outside the US, and we only cover US events for now\.\n\nI’m sorry I can’t help with Hamilton yet\. If I’ve got that wrong, just reply and tell me\./);
    expect(r.text).not.toContain("We're sorry");
    const bare = renderTemplate('unsupported', { reason: 'For now I only cover events in the US.' }, ctx);
    expect(bare.text).toContain('I’m sorry I can’t help with this one yet.');
  });
});

describe('a later message while the answer waits for review (audit gap 3)', () => {
  const brief = (over: Partial<RequestExtraction>) => ({ quantity: 2, budgetCents: 30000, budgetBasis: 'whole_party', seatingPreference: null, ...over }) as RequestExtraction;
  it('says what changed and that the updated answer is coming, in one line, with no time promised', () => {
    expect(revisionNote(brief({}), brief({ quantity: 4 }), null)).toBe('Got your update: 4 tickets. I’m rechecking with that, and the updated answer will come here in this thread.');
    expect(revisionNote(brief({}), brief({ budgetCents: 40000, seatingPreference: 'lower bowl' }), null)).toBe('Got your update: $400 total and lower bowl. I’m rechecking with that, and the updated answer will come here in this thread.');
    expect(revisionNote(brief({}), brief({}), 'New York Rangers vs. Boston Bruins')).toContain('Got your update: New York Rangers vs. Boston Bruins.');
    expect(revisionNote(brief({}), brief({}), null)).toBe('Got your note. I’m taking it into account, and the updated answer will come here in this thread.');
  });
  it('goes out as a short acknowledgment: greeting, the line, nothing else', () => {
    const r = renderTemplate('acknowledgment', { update: revisionNote(brief({}), brief({ quantity: 4 }), null) }, ctx);
    expect(r.text.split('\n\n').slice(0, 2)).toEqual(['Hey,', 'Got your update: 4 tickets. I’m rechecking with that, and the updated answer will come here in this thread.']);
    expect(r.text).not.toMatch(/Here's what I have|shortly/);
  });
});
