import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { Concierge, eventChangedSince } from '@/lib/intake/pipeline';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { setKillSwitch } from '@/lib/email/send-gate';
import { TEST_MODE_KEY } from '@/lib/email/test-mode';
import { openTestDb, inbound, testEnv, RecordingProvider } from '../harness';

/**
 * R2-LIFECYCLE-01: a recommendation written while the event was scheduled ("I'd secure the $250 seats") was
 * approved and sent after the event was cancelled. Fresh prices don't prove the event still happens: approval and
 * send both check the event is still scheduled, at the start the advice was written for, and hasn't begun.
 * The Research2 post-deploy controls, on one synthetic concert with one manually checked offer each.
 */
const NOW = new Date('2026-09-30T23:15:00Z');
const START = new Date('2026-10-17T23:00:00Z');
const MOVED = new Date('2026-10-24T23:00:00Z');
type Change = { status?: string; localStartAt?: Date };

async function control(id: string, change: Change | null, phase: 'before' | 'after') {
  const h = await openTestDb();
  try {
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    const [venue] = await h.db.insert(t.venues).values({ name: 'QA Test Room A', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' }).returning();
    const [artist] = await h.db.insert(t.entities).values({ kind: 'performer', name: 'QA Example Artist', slug: 'qa-example-artist', aliases: [] }).returning();
    const [event] = await h.db.insert(t.events).values({ name: 'QA Example Artist', category: 'concert', venueId: venue!.id, primaryEntityId: artist!.id, localStartAt: START, status: 'scheduled', isFixture: false }).returning();
    await h.db.update(t.adapterConfigs).set({ enabled: true, monitoringAllowed: true }).where(eq(t.adapterConfigs.sourceId, FX.source));
    await h.db.insert(t.eventSourceMappings).values({ eventId: event!.id, sourceId: FX.source, sourceEventId: 'qa-lifecycle-synthetic', role: 'marketplace', confidence: 'verified', verifiedAt: NOW });
    await setKillSwitch(h.db, TEST_MODE_KEY, true, 'qa', 'capture only');
    const provider = new RecordingProvider();
    const c = new Concierge({ db: h.db, env: testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', HUMAN_REVIEW_REQUIRED: 'true', SERVICE_POLICY_MODE: 'shadow' }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => NOW, emailProvider: provider, fixtureOffers: {} });
    const r = (await c.ingestInbound(inbound({ text: 'Two adjacent reserved tickets for QA Example Artist in New York on October 17, 2026. Budget $300 TOTAL including fees. I must attend.', from: `${id}@customer.example`, subject: 'Lifecycle', receivedAt: NOW }))) as { requestId: string };
    for (let n = 0; n < 6; n++) {
      const work = await leaseDueOutbox(h.db, { limit: 50, now: NOW });
      if (!work.length) break;
      for (const ev of work) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
      }
    }
    const [request] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    expect(request!.eventId).toBe(event!.id);
    await c.addManualOffer({ staffUserId: 'qa', requestId: r.requestId, sourceId: 'stubhub', sourceUrl: 'https://example.com/offer', observedAt: NOW, quantity: 2, section: '101', row: 'A', seatsTogether: true, payableTotalCents: 25000, baseTotalCents: 21000, feesKnown: true, taxKnown: true, deliveryMethod: 'mobile_transfer', restrictions: [], evidenceNote: 'synthetic', seatClass: 'reserved' });
    const researched = await c.research({ requestId: r.requestId, revision: request!.currentRevision });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.id, researched.recommendationId!));
    expect(rec!.chosenObservationIds).toHaveLength(1);
    const mutate = async () => {
      if (change) await h.db.update(t.events).set(change).where(eq(t.events.id, event!.id));
    };
    if (phase === 'before') await mutate();
    const approval = await c.approveRecommendation({ recommendationId: rec!.id, reviewerUserId: 'qa', expectedRevision: request!.currentRevision, draftHash: rec!.draftHash, note: null });
    if (phase === 'after') await mutate();
    const dispatched = approval.ok ? await c.dispatchSend(approval.sendIntentId) : null;
    const outbound = (await h.db.select().from(t.messages).where(eq(t.messages.conversationId, request!.conversationId))).filter((m) => m.direction === 'outbound'); // only the recommendation is ever dispatched here
    const [after] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.id, rec!.id));
    return { approval, dispatched, outbound: outbound.length, reviewStatus: after!.reviewStatus, providerCalls: provider.sent.length };
  } finally {
    await h.close();
  }
}

describe('advice for an event that has changed is never sent', () => {
  it('L00: a scheduled event with fresh evidence is approved and captured', async () => {
    const r = await control('l00', null, 'before');
    expect(r.approval).toMatchObject({ ok: true });
    expect(r.dispatched).toEqual({ outcome: 'sent' });
    expect(r.outbound).toBe(1);
    expect(r.providerCalls).toBe(0);
  });

  it.each([
    ['L01 cancelled', { status: 'cancelled' }, 'event_cancelled'],
    ['L02 postponed', { status: 'postponed' }, 'event_postponed'],
    ['L03 date moved', { localStartAt: MOVED }, 'event_rescheduled'],
  ])('%s before approval: approval refused and the draft invalidated', async (_label, change, reason) => {
    const r = await control(`before-${reason}`, change, 'before');
    expect(r.approval).toMatchObject({ ok: false, status: 409, reason });
    expect(r.reviewStatus).toBe('invalidated');
    expect(r.outbound).toBe(0);
  });

  it.each([
    ['L04 cancelled', { status: 'cancelled' }, 'event_cancelled'],
    ['L05 postponed', { status: 'postponed' }, 'event_postponed'],
    ['L06 date moved', { localStartAt: MOVED }, 'event_rescheduled'],
  ])('%s after approval: the queued send is blocked', async (_label, change, reason) => {
    const r = await control(`after-${reason}`, change, 'after');
    expect(r.approval).toMatchObject({ ok: true });
    expect(r.dispatched).toMatchObject({ outcome: 'blocked', reasons: expect.arrayContaining([reason]) });
    expect(r.reviewStatus).toBe('invalidated');
    expect(r.outbound).toBe(0);
    expect(r.providerCalls).toBe(0);
  });
});

describe('eventChangedSince', () => {
  const scheduled = { status: 'scheduled', localStartAt: START };
  it('passes the occurrence the advice was written for', () => {
    expect(eventChangedSince(scheduled, NOW, START.toISOString())).toBeNull();
    expect(eventChangedSince(scheduled, NOW)).toBeNull();
  });
  it('names what changed', () => {
    expect(eventChangedSince(undefined, NOW)).toBe('event_missing');
    expect(eventChangedSince({ ...scheduled, status: 'cancelled' }, NOW)).toBe('event_cancelled');
    expect(eventChangedSince(scheduled, NOW, MOVED.toISOString())).toBe('event_rescheduled');
    expect(eventChangedSince(scheduled, new Date(START.getTime() + 60_000))).toBe('event_started');
  });
  it('does not take an unrecorded occurrence as a match', () => {
    expect(eventChangedSince(scheduled, NOW, null)).toBe('event_occurrence_unrecorded');
  });
});
