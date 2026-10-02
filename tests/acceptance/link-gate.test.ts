import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { Concierge } from '@/lib/intake/pipeline';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { boundDestination, destinationMatches, linkDecision, recheckPage } from '@/lib/links/click';
import { openTestDb, inbound, testEnv } from '../harness';

let handle: DbHandle;
vi.mock('@/lib/db', async (orig) => ({ ...(await orig<typeof import('@/lib/db')>()), getDb: async () => handle }));

/**
 * R2-LINK-STALE-01 / R2-LINK-CONTEXT-01 (Research2 link and email journey, Oct 1 2026): a buy link in sent advice
 * redirected even after the advice expired, and a link bound to one event redirected to whatever URL was stored.
 * A buy link is now made by research, bound to its event and advice run, and checked at click time; reference
 * links are not; links stored before purposes were recorded say so. One synthetic concert, one manual offer.
 */
const NOW = new Date('2026-09-30T23:15:00Z');
const START = new Date('2026-10-17T23:00:00Z');
const SELLER = 'https://example.com/seller/offer-101';

describe('buy links are checked at click time', () => {
  const clock = NOW;
  let c: Concierge;
  let requestId: string;
  let eventId: string;
  let buy: typeof t.trackedLinks.$inferSelect;
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  const reload = async () => (await handle.db.select().from(t.trackedLinks).where(eq(t.trackedLinks.id, buy.id)))[0]!;

  beforeAll(async () => {
    handle = await openTestDb();
    const h = handle;
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    const [venue] = await h.db.insert(t.venues).values({ name: 'QA Test Room A', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' }).returning();
    const [artist] = await h.db.insert(t.entities).values({ kind: 'performer', name: 'QA Example Artist', slug: 'qa-link-artist', aliases: [] }).returning();
    const [event] = await h.db.insert(t.events).values({ name: 'QA Example Artist', category: 'concert', venueId: venue!.id, primaryEntityId: artist!.id, localStartAt: START, status: 'scheduled', isFixture: false }).returning();
    eventId = event!.id;
    await h.db.update(t.adapterConfigs).set({ enabled: true, monitoringAllowed: true }).where(eq(t.adapterConfigs.sourceId, FX.source));
    await h.db.insert(t.eventSourceMappings).values({ eventId, sourceId: FX.source, sourceEventId: 'qa-link-synthetic', role: 'marketplace', confidence: 'verified', verifiedAt: NOW });
    c = new Concierge({ db: h.db, env: testEnv({ APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_test_key', HUMAN_REVIEW_REQUIRED: 'true', SERVICE_POLICY_MODE: 'shadow' }), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => clock, emailProvider: null, fixtureOffers: {} });
    const r = (await c.ingestInbound(inbound({ text: 'Two adjacent reserved tickets for QA Example Artist in New York on October 17, 2026. Budget $300 TOTAL including fees. I must attend.', from: 'links@customer.example', subject: 'Links', receivedAt: NOW }))) as { requestId: string };
    requestId = r.requestId;
    for (const ev of await leaseDueOutbox(h.db, { limit: 50, now: NOW })) {
      const p = ev.payload as Record<string, string>;
      if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, NOW);
    }
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    await c.addManualOffer({ staffUserId: 'qa', requestId, sourceId: 'stubhub', sourceUrl: SELLER, observedAt: NOW, quantity: 2, section: '101', row: 'A', seatsTogether: true, payableTotalCents: 25000, baseTotalCents: 21000, feesKnown: true, taxKnown: true, deliveryMethod: 'mobile_transfer', restrictions: [], evidenceNote: 'synthetic', seatClass: 'reserved' });
    await c.research({ requestId, revision: req!.currentRevision });
    const [made] = await h.db.select().from(t.trackedLinks).where(and(eq(t.trackedLinks.requestId, requestId), eq(t.trackedLinks.purpose, 'buy')));
    buy = made!;
  });
  afterAll(async () => {
    await handle.close();
  });

  it('research makes the offer link a buy link, bound to its event and advice', async () => {
    expect(buy).toMatchObject({ url: SELLER, purpose: 'buy', eventId });
    expect(buy.adviceRunId).toBeTruthy();
    const [rec] = await handle.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    expect(rec!.adviceRunId).toBe(buy.adviceRunId);
    expect(rec!.bodyText).toContain(`/go/${buy.id}`);
  });

  it('a fresh buy link goes straight to the seller', async () => {
    expect(await linkDecision(handle.db, buy, at(5))).toEqual({ go: true, url: SELLER, legacy: false });
  });

  it('a stale price gets the recheck page, with when it was checked', async () => {
    expect(await linkDecision(handle.db, buy, at(20))).toMatchObject({ go: false, reason: 'price_stale', checkedAt: NOW });
  });

  it('the route: fresh redirects; stale shows why, and the current page is offered as that', async () => {
    const { GET } = await import('@/app/go/[id]/route');
    const get = (q = '') => GET(new Request(`https://ticketguy.test/go/${buy.id}${q}`, { headers: { 'user-agent': 'Mozilla/5.0' } }), { params: Promise.resolve({ id: buy.id }) });
    vi.useFakeTimers({ now: at(5), toFake: ['Date'] });
    const fresh = await get();
    expect(fresh.status).toBe(302);
    expect(fresh.headers.get('location')).toBe(SELLER);
    vi.setSystemTime(at(60));
    const stale = await get();
    expect(stale.status).toBe(200);
    const html = await stale.text();
    expect(html).toContain('Check the price before you buy');
    expect(html).toContain('The price I quoted for QA Example Artist at QA Test Room A, Sat, Oct 17 was checked on Sep 30, 7:15 PM EDT.');
    expect(html).toContain(`href="/go/${buy.id}?current=1"`);
    expect(html).toContain('Go to the seller’s current page</a> (its prices and seats today, not the ones I quoted)');
    expect(html).not.toContain(SELLER);
    const onward = await get('?current=1');
    expect(onward.status).toBe(302);
    expect(onward.headers.get('location')).toBe(SELLER);
    vi.useRealTimers();
    const clicks = await handle.db.select().from(t.requestOutcomes).where(and(eq(t.requestOutcomes.requestId, requestId), eq(t.requestOutcomes.kind, 'link_click')));
    expect(clicks.map((x) => (x.details as { gated?: string; current?: boolean }))).toEqual(expect.arrayContaining([expect.objectContaining({ gated: 'price_stale' }), expect.objectContaining({ current: true })]));
  });

  it('withdrawn or replaced advice, another event, or a cancelled one, all stop the redirect', async () => {
    const [rec] = await handle.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    await handle.db.update(t.recommendations).set({ reviewStatus: 'invalidated' }).where(eq(t.recommendations.id, rec!.id));
    expect(await linkDecision(handle.db, buy, at(5))).toMatchObject({ go: false, reason: 'advice_withdrawn' });
    await handle.db.update(t.recommendations).set({ reviewStatus: 'sent' }).where(eq(t.recommendations.id, rec!.id));
    await handle.db.update(t.requests).set({ currentRevision: rec!.revision + 1 }).where(eq(t.requests.id, requestId));
    expect(await linkDecision(handle.db, buy, at(5))).toMatchObject({ go: false, reason: 'advice_superseded' });
    await handle.db.update(t.requests).set({ currentRevision: rec!.revision, eventId: FX.events.knicks }).where(eq(t.requests.id, requestId));
    expect(await linkDecision(handle.db, buy, at(5))).toMatchObject({ go: false, reason: 'other_event' });
    await handle.db.update(t.requests).set({ eventId }).where(eq(t.requests.id, requestId));
    await handle.db.update(t.events).set({ status: 'cancelled' }).where(eq(t.events.id, eventId));
    expect(await linkDecision(handle.db, buy, at(5))).toMatchObject({ go: false, reason: 'event_cancelled' });
    await handle.db.update(t.events).set({ status: 'scheduled' }).where(eq(t.events.id, eventId));
    expect(await linkDecision(handle.db, await reload(), at(5))).toMatchObject({ go: true });
  });

  // R2 retest: fresh observations don't carry advice past its own expiresAt.
  it('advice past its expiresAt is gated even on fresh prices, at the boundary too', async () => {
    const [rec] = await handle.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    const original = rec!.expiresAt;
    await handle.db.update(t.recommendations).set({ expiresAt: at(10) }).where(eq(t.recommendations.id, rec!.id));
    try {
      expect(await linkDecision(handle.db, buy, at(9))).toEqual({ go: true, url: SELLER, legacy: false });
      for (const m of [10, 11]) expect(await linkDecision(handle.db, buy, at(m))).toMatchObject({ go: false, reason: 'advice_expired', until: at(10) });
      const page = recheckPage((await linkDecision(handle.db, buy, at(11))) as Parameters<typeof recheckPage>[0], `/go/${buy.id}?current=1`);
      expect(page).toContain('This advice has expired');
      expect(page).toContain('was good until Sep 30, 7:25 PM EDT, and that time has passed.');
      expect(page).toContain(`href="/go/${buy.id}?current=1"`);
      // Reference and legacy links keep redirecting after it.
      expect(await linkDecision(handle.db, { ...buy, purpose: 'reference' }, at(11))).toMatchObject({ go: true });
      expect(await linkDecision(handle.db, { ...buy, purpose: 'legacy' }, at(11))).toMatchObject({ go: true, legacy: true });
    } finally {
      await handle.db.update(t.recommendations).set({ expiresAt: original }).where(eq(t.recommendations.id, rec!.id));
    }
  });

  // R2-LINK-CONTEXT-01: a stored destination that isn't the advised offer's is never followed, even via "current page".
  it('a buy link whose stored URL is not the offer it was made for is not followed', async () => {
    const { GET } = await import('@/app/go/[id]/route');
    const get = (q = '') => GET(new Request(`https://ticketguy.test/go/${buy.id}${q}`, { headers: { 'user-agent': 'Mozilla/5.0' } }), { params: Promise.resolve({ id: buy.id }) });
    const WRONG = 'https://example.com/another-artist-denver-2026-10-18';
    await handle.db.update(t.trackedLinks).set({ url: WRONG }).where(eq(t.trackedLinks.id, buy.id));
    vi.useFakeTimers({ now: at(5), toFake: ['Date'] });
    try {
      expect(await linkDecision(handle.db, await reload(), at(5))).toMatchObject({ go: false, reason: 'destination_mismatch' });
      for (const q of ['', '?current=1']) {
        const r = await get(q);
        expect(r.status, q).toBe(200);
        expect(r.headers.get('location')).toBeNull();
        const html = await r.text();
        expect(html).toContain('This link doesn’t match my advice');
        expect(html).not.toContain('current page');
        expect(html).not.toContain(WRONG);
      }
    } finally {
      vi.useRealTimers();
      await handle.db.update(t.trackedLinks).set({ url: SELLER }).where(eq(t.trackedLinks.id, buy.id));
    }
    expect(await linkDecision(handle.db, await reload(), at(5))).toMatchObject({ go: true });
  });

  it('an affiliate wrapper of the advised offer is the same destination; a slug is not identity', () => {
    const obs = [{ eventId: 'e1', offerId: 'o1' }];
    const offers = new Map([['o1', { eventId: 'e1', directPurchaseUrl: SELLER, affiliateUrl: 'https://aff.example/r/abc' }]]);
    expect(destinationMatches(SELLER, 'e1', obs, offers)).toBe(true);
    expect(destinationMatches('https://aff.example/r/abc', 'e1', obs, offers)).toBe(true);
    expect(destinationMatches(`https://aff.example/track?pub=1&u=${encodeURIComponent(SELLER)}`, 'e1', obs, offers)).toBe(true);
    // Another event's offer, or a URL that only looks right, is not it.
    expect(destinationMatches(SELLER, 'e2', obs, offers)).toBe(false);
    expect(destinationMatches(`${SELLER}-qa-example-artist`, 'e1', obs, offers)).toBe(false);
    expect(destinationMatches(SELLER, 'e1', [{ eventId: 'e2', offerId: 'o1' }], offers)).toBe(false);
  });

  it('at creation, a buy link binds only to its observation’s own destination at that event', async () => {
    const [rec] = await handle.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    expect(await boundDestination(handle.db, SELLER, rec!.chosenObservationIds, eventId)).toBe(true);
    expect(await boundDestination(handle.db, 'https://example.com/another-artist-denver-2026-10-18', rec!.chosenObservationIds, eventId)).toBe(false);
    expect(await boundDestination(handle.db, SELLER, rec!.chosenObservationIds, FX.events.knicks)).toBe(false);
    expect(await boundDestination(handle.db, SELLER, [], eventId)).toBe(false);
  });

  it('reference links redirect; a legacy link says so; a buy link with no advice is not trusted', async () => {
    const ref = { ...buy, purpose: 'reference', adviceRunId: null };
    expect(await linkDecision(handle.db, ref, at(600))).toEqual({ go: true, url: SELLER, legacy: false });
    expect(await linkDecision(handle.db, { ...ref, purpose: 'legacy' }, at(600))).toEqual({ go: true, url: SELLER, legacy: true });
    expect(await linkDecision(handle.db, { ...buy, adviceRunId: null }, at(5))).toMatchObject({ go: false, reason: 'unbound' });
  });
});
