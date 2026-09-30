import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FIXTURE_NOW } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, inbound, testEnv, RecordingProvider } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';

// Live mode with no synthetic offers served, so the advice email can actually be sent (the gate refuses
// fixture content), which is what hands the request to its owner.
const makeConcierge = (h: DbHandle, o: { env: ReturnType<typeof testEnv>; provider: RecordingProvider }) =>
  new Concierge({ db: h.db, env: o.env, extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => FIXTURE_NOW, emailProvider: o.provider, fixtureOffers: {} });

/**
 * The staffed comparison pilot (DECISION_LOG #54). "I haven't checked those requirements" is honest but leaves
 * the customer shopping. When nothing verified meets what they asked for, and only when a named staff owner
 * exists, a person takes it on: the email says so, the request waits on that owner, the owner is alerted with
 * what to record, and the pilot stops offering after its limit of customer requests.
 */
const OWNER = 'owner@ticketguy.test';
const liveEnv = (over: Record<string, string> = {}) =>
  testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', EXTRACTION_PROVIDER: 'rules', STAFF_EMAIL_ALLOWLIST: OWNER, STAFF_COMPARISON_OWNER: OWNER, STAFF_COMPARISON_LIMIT: '3', ...over });

describe('the staffed comparison pilot', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  const run = async (c: Concierge, from: string, text = 'Rangers Oct 3, 3 tickets together, $450 total including fees. What is the best suitable option?') => {
    const r = (await c.ingestInbound(inbound({ text, from, subject: 'Rangers for three' }))) as { requestId: string };
    for (let i = 0; i < 12; i++) {
      const leased = await leaseDueOutbox(h.db, { limit: 50, now: FIXTURE_NOW });
      if (!leased.length) break;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else if (ev.eventType === 'research.requested') await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        else if (ev.eventType === 'email.send_requested') await c.dispatchSend(p.sendIntentId!);
        else if (ev.eventType === 'staff.alert') await c.alertStaff({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, FIXTURE_NOW);
      }
    }
    const advice = (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, r.requestId))).find((s) => s.dedupeKey.startsWith('rec:'));
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    const offered = await h.db.select().from(t.requestOutcomes).where(and(eq(t.requestOutcomes.requestId, r.requestId), eq(t.requestOutcomes.kind, 'staff_comparison_offered')));
    return { requestId: r.requestId, advice, state: req!.state, offered };
  };

  it('with no owner configured, nothing is promised: the honest limit only', async () => {
    const provider = new RecordingProvider();
    const c = makeConcierge(h, { env: liveEnv({ STAFF_COMPARISON_OWNER: '', EMAIL_TEST_RECIPIENT_ALLOWLIST: 'nobody-owns@customer.example' }), provider });
    const r = await run(c, 'nobody-owns@customer.example');
    expect(r.advice?.bodyText).toContain('I haven’t been able to check these against any seats yet');
    expect(r.advice?.bodyText).not.toContain('a person on our team');
    expect(r.offered).toHaveLength(0);
    expect(r.state).not.toBe('manual_attention');
  });

  it('with an owner: the email says a person is looking, the request waits on the owner, and the owner is told what to record', async () => {
    const provider = new RecordingProvider();
    const c = makeConcierge(h, { env: liveEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'pilot1@customer.example' }), provider });
    const r = await run(c, 'pilot1@customer.example');
    const body = r.advice!.bodyText;
    expect(body).toContain('I haven’t been able to check these against any seats yet: 3 seats together and $450 in total for all 3, once fees are added.');
    expect(body).toContain('So you don’t have to do the shopping: a person on our team is now looking for seats that meet all of them, checking sellers by hand. They’ll reply in this thread with the options they find and their all-in totals, or tell you plainly if nothing fits. The team replies from 9am to 9pm ET.');
    // They aren't asked to go and find seats themselves.
    expect(body).not.toContain('Found seats you like?');
    expect(r.advice!.state, String(r.advice!.lastError)).toBe('provider_accepted');
    expect(r.state).toBe('manual_attention');
    expect(r.offered).toHaveLength(1);
    expect(r.offered[0]!.details).toMatchObject({ owner: OWNER, counted: true });
    const alert = provider.sent.find((s) => s.to === OWNER && s.subject.startsWith('Needs a person'));
    expect(alert?.subject).toBe('Needs a person: a comparison was promised: find seats that meet their requirements');
    expect(alert?.text).toContain('The customer has been told a person is looking for seats that meet their requirements and will reply in the thread. Record each option you check under Manual offers');
  });

  it('the owner records a verified option and re-runs research: the comparison goes out, and the pilot measures it', async () => {
    const provider = new RecordingProvider();
    const env = liveEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: 'pilot-answer@customer.example' });
    const c = makeConcierge(h, { env, provider });
    const r = await run(c, 'pilot-answer@customer.example');
    await c.addManualOffer({ staffUserId: 'owner', requestId: r.requestId, sourceId: 'ticketmaster', sourceUrl: 'https://www.ticketmaster.com/event/x', observedAt: FIXTURE_NOW, quantity: 3, section: '214', row: 'F', seatsTogether: true, payableTotalCents: 42000, baseTotalCents: 36000, feesKnown: true, taxKnown: true, deliveryMethod: 'mobile_transfer', restrictions: [], evidenceNote: 'Checked by hand on the seller page: three together, all-in at checkout.', seatClass: 'upper' });
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, r.requestId));
    await c.research({ requestId: r.requestId, revision: req!.currentRevision });
    const recs = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, r.requestId));
    const latest = recs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(latest.bodyText).toContain('3 seats together in section 214: $420 total ($140 each) including the verified charges');
    expect(latest.bodyText).not.toContain('a person on our team is now looking');
    const answered = await h.db.select().from(t.requestOutcomes).where(and(eq(t.requestOutcomes.requestId, r.requestId), eq(t.requestOutcomes.kind, 'staff_comparison_answered')));
    expect(answered).toHaveLength(1);
    expect(answered[0]!.details).toMatchObject({ sourceId: 'ticketmaster', totalCents: 42000 });
  });

  it('stops offering after its limit of customer requests; staff tests are served but not counted', async () => {
    const provider = new RecordingProvider();
    const env = liveEnv({ EMAIL_TEST_RECIPIENT_ALLOWLIST: `pilot2@customer.example,pilot3@customer.example,${OWNER}` });
    // Four tickets: the three-ticket option staff verified above would (rightly) answer a three-ticket request.
    const four = 'Rangers Oct 3, 4 tickets together, $560 total including fees. What is the best suitable option?';
    const staffTest = await run(makeConcierge(h, { env, provider }), OWNER, four);
    expect(staffTest.offered[0]!.details).toMatchObject({ counted: false });
    const second = await run(makeConcierge(h, { env, provider }), 'pilot2@customer.example', four);
    expect(second.offered).toHaveLength(1); // the third counted request: the limit is 3
    const third = await run(makeConcierge(h, { env, provider }), 'pilot3@customer.example', four);
    expect(third.offered).toHaveLength(0);
    expect(third.advice?.bodyText).not.toContain('a person on our team');
  });
});
