import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { FX } from '@/lib/fixtures';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { Concierge } from '@/lib/intake/pipeline';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { openTestDb, inbound, testEnv } from '../harness';

let handle: DbHandle;
vi.mock('@/lib/db', async (orig) => ({ ...(await orig<typeof import('@/lib/db')>()), getDb: async () => handle }));

/**
 * The Research 2 retest's route matrix (Oct 1 2026, a80744b; local/redirect-independent.test.ts), ported. On a80744b
 * two rows were wrong: advice past its expiresAt still redirected (R2-LINK-STALE-01), and a stored URL changed to
 * another destination still redirected (R2-LINK-CONTEXT-01, a characterization there, a guard here). Added rows:
 * the expiry boundary, the current-page choice on a mismatched link, and a legitimate affiliate wrapper.
 *
 * R2-LINK-STALE-01 / R2-LINK-CONTEXT-01 (Research2 link and email journey, Oct 1 2026): a buy link in sent advice
 * redirected even after the advice expired, and a link bound to one event redirected to whatever URL was stored.
 * A buy link is now made by research, bound to its event and advice run, and checked at click time; reference
 * links are not; links stored before purposes were recorded say so. One synthetic concert, one manual offer.
 */
const NOW = new Date('2026-09-30T23:15:00Z');
const START = new Date('2026-10-17T23:00:00Z');
const SELLER = 'https://example.com/seller/offer-101';
const AFF = 'https://partner.example.net/c/123?u=' + encodeURIComponent(SELLER);

describe('Independent actual redirect caller', () => {
  const clock = NOW;
  let c: Concierge;
  let requestId: string;
  let eventId: string;
  let buy: typeof t.trackedLinks.$inferSelect;
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

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


 it('lifecycle, source ageing, advice expiry and destination binding at the actual GET handler',async()=>{
  const {GET}=await import('@/app/go/[id]/route');
  const [rec]=await handle.db.select().from(t.recommendations).where(eq(t.recommendations.adviceRunId,buy.adviceRunId!));
  const originals=await handle.db.select().from(t.offerObservations);
  const cases=[
   {id:'fresh',mins:5,want:302}, {id:'aged-fetch',mins:20,want:200,reason:'price_stale'},
   {id:'aged-source-fresh-fetch',mins:5,want:200,reason:'price_stale',sourceOld:true},
   {id:'explicit-advice-expired-fresh-observation',mins:5,want:200,expired:true,reason:'advice_expired'},
   {id:'advice-expiry-boundary',mins:5,want:200,expiresAtNow:true,reason:'advice_expired'},
   {id:'advice-valid-one-minute-left',mins:5,want:302,expiresIn:1},
   {id:'withdrawn',mins:5,want:200,review:'invalidated',reason:'advice_withdrawn'},
   {id:'replaced-revision',mins:5,want:200,revision:true,reason:'advice_superseded'},
   {id:'request-other-event',mins:5,want:200,other:true,reason:'other_event'},
   {id:'cancelled',mins:5,want:200,status:'cancelled',reason:'event_cancelled'},
   {id:'postponed',mins:5,want:200,status:'postponed',reason:'event_postponed'},
   {id:'rescheduled-status',mins:5,want:200,status:'rescheduled',reason:'event_rescheduled'},
   {id:'moved-start',mins:5,want:200,moved:true,reason:'event_rescheduled'},
   {id:'started',mins:Math.round((START.getTime()-NOW.getTime())/60000)+1,want:200,reason:'event_started'},
   {id:'reference-after-expiry',mins:60,want:302,purpose:'reference'},
   {id:'legacy-after-expiry',mins:60,want:302,purpose:'legacy'},
   {id:'unbound-new-buy',mins:5,want:200,unbound:true,reason:'unbound'},
   {id:'explicit-current-page-after-stale',mins:60,want:302,current:true},
   {id:'intentionally-mismapped-seller-url',mins:5,want:200,badUrl:true,reason:'destination_mismatch'},
   {id:'mismapped-url-current-page-choice',mins:5,want:200,badUrl:true,current:true,reason:'destination_mismatch'},
   {id:'legitimate-affiliate-wrapper',mins:5,want:302,affiliateWrap:true},
  ];
  vi.useFakeTimers({now:at(5),toFake:['Date']});
  try{
   for(const k of cases){
    await handle.db.update(t.requests).set({eventId:k.other?FX.events.knicks:eventId,currentRevision:k.revision?rec!.revision+1:rec!.revision}).where(eq(t.requests.id,requestId));
    await handle.db.update(t.events).set({status:k.status??'scheduled',localStartAt:k.moved?new Date(START.getTime()+86400000):START}).where(eq(t.events.id,eventId));
    await handle.db.update(t.recommendations).set({reviewStatus:k.review??'sent',expiresAt:k.expired?at(-1):k.expiresAtNow?at(5):k.expiresIn?at(5+k.expiresIn):at(15)}).where(eq(t.recommendations.id,rec!.id));
    await handle.db.update(t.trackedLinks).set({purpose:k.purpose??'buy',adviceRunId:k.unbound?null:buy.adviceRunId,url:k.badUrl?'https://example.com/another-artist-denver-2026-10-18':k.affiliateWrap?AFF:SELLER}).where(eq(t.trackedLinks.id,buy.id));
    // The offer's own affiliate wrapper, stored with it, is a destination of that offer.
    for(const o of originals)await handle.db.update(t.offers).set({affiliateUrl:k.affiliateWrap?AFF:null}).where(eq(t.offers.id,o.offerId));
    for(const o of originals)await handle.db.update(t.offerObservations).set({fetchedAt:k.sourceOld?at(4):o.fetchedAt,sourceAsOf:k.sourceOld?at(-30):o.sourceAsOf}).where(eq(t.offerObservations.id,o.id));
    vi.setSystemTime(at(k.mins));
    const response=await GET(new Request('https://ticketguy.test/go/'+buy.id+(k.current?'?current=1':''),{headers:{'user-agent':'Mozilla/5.0'}}),{params:Promise.resolve({id:buy.id})});
    const body=await response.text();const clicks=await handle.db.select().from(t.requestOutcomes).where(eq(t.requestOutcomes.requestId,requestId));
    expect(response.status,k.id).toBe(k.want);
    if(k.reason)expect(clicks.at(-1)?.details,k.id).toMatchObject({gated:k.reason});
    if(response.status===200)expect(response.headers.get('location'),k.id).toBeNull();
    // A link that no longer points to the offer checked offers no way on to it, current page or not.
    if(k.reason==='destination_mismatch')expect(body,k.id).not.toMatch(/seller’s current page|another-artist/);
   }
  }finally{vi.useRealTimers();}
 });
});
