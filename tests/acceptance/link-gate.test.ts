import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { Concierge } from '@/lib/intake/pipeline';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { linkDecision } from '@/lib/links/click';
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

  it('reference links redirect; a legacy link says so; a buy link with no advice is not trusted', async () => {
    const ref = { ...buy, purpose: 'reference', adviceRunId: null };
    expect(await linkDecision(handle.db, ref, at(600))).toEqual({ go: true, url: SELLER, legacy: false });
    expect(await linkDecision(handle.db, { ...ref, purpose: 'legacy' }, at(600))).toEqual({ go: true, url: SELLER, legacy: true });
    expect(await linkDecision(handle.db, { ...buy, adviceRunId: null }, at(5))).toMatchObject({ go: false, reason: 'unbound' });
  });
});
