import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { openTestDb, inbound, testEnv, RecordingProvider } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';

/**
 * SeatData price watch retest, expanded controls (Oct 1 2026, deployed a80744b): the package's X01-X10, ported with
 * its exact phrasings. On a80744b, X09 fails: a 503 with one call left made three attempts (PW-CALL-BUDGET-01).
 *
 * A price watch on SeatData's resale listings (DECISION_LOG #62), against a fake SeatData shaped like its payloads:
 * "4 together for less than $400, alert me". No seller can be monitored, as in production. The watch exists only
 * when the licence allows alerts (or tracking while email goes only to the owner's testers); each look is one
 * listings read; an alert is a heads-up on listed prices with the fee allowance said, approved by staff, and as
 * fresh as the read behind it.
 */
const MIN = 60_000;
const QA_NOW = new Date('2026-10-01T23:30:00Z');
const KEY = 'ab'.repeat(32);

describe('expanded independent price-watch controls', () => {
  let h: DbHandle;
  let now = QA_NOW;
  let listings: Array<Record<string, unknown>> = [];
  let reads = 0;
  let failListings = false;
  let seq = 0;
  const captures: Array<Record<string,unknown>> = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.pathname === '/api/v1/events/search') {
      if (url.searchParams.get('tm_event_id') === 'TMWATCH1') return json({ data: [{ event_id: 555, tm_event_id: 'TMWATCH1', event_name: 'Metro Watchers vs. Boston', event_date: '2026-10-30', venue_name: 'Watch Garden', venue_city: 'New York', venue_state: 'NY' }], has_more: false, next_cursor: null });
      return json({ data: [], has_more: false, next_cursor: null });
    }
    if (url.pathname === '/api/v1/events/555/stats') return json({ event_id: 555, data: [], has_more: false, next_cursor: null });
    if (url.pathname === '/api/v1/events/555/sales') return json({ event_id: 555, data: [], has_more: false, next_cursor: null });
    if (url.pathname === '/api/v0.1.1/listings/get' && url.searchParams.get('event_id') === '555') {
      reads += 1;
      if (failListings) return new Response('{}', {status:503});
      return json({ has_refreshed: true, last_refresh_timestamp: Math.floor(now.getTime() / 1000), listings }); // refreshed as we read it
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  // Email unrestricted (no tester allowlist), so only the licence's alerts use lets SeatData watch.
  const env = (over: Record<string, string> = {}) => testEnv({ SEATDATA_API_KEY: KEY, WATCH_SEND_ENABLED: 'true', EMAIL_TEST_RECIPIENT_ALLOWLIST: '', ...over });
  const concierge = (over: Record<string, string> = {}, provider: RecordingProvider | null = null) => new Concierge({ db: h.db, env: env(over), extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: provider, marketFetch: fetchImpl });
  const setLicence = (uses: string[]) => h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: uses, licenseReference: 'test: SeatData email 2026-10-01, alerts to customers allowed' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
  const ASK = 'Watchers Oct 30, 4 tickets together, $400 total including fees. Please watch this for me and alert me if you find them.';
  const ask = async (c: Concierge, text: string, from: string) => {
    const r = (await c.ingestInbound(inbound({ text, from, subject: 'Watchers' }))) as { requestId: string };
    for (const ev of (await leaseDueOutbox(h.db, { limit: 50, now })).filter((e) => e.eventType === 'request.interpret')) {
      const p = ev.payload as Record<string, string>;
      await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
      await markDispatched(h.db, ev.id, ev.leaseToken, now);
    }
    return r.requestId;
  };
  const watchFor = async (requestId: string) => (await h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId)))[0];
  const alertsFor = async (watchId: string) => h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.watchId, watchId));
  // Only this watch is due: earlier cases' watches are moved out of the way.
  const evaluateAt = async (watchId: string, at: Date) => {
    now = at;
    await h.db.update(t.watches).set({ nextCheckAt: new Date('2026-10-29T00:00:00Z') }).where(ne(t.watches.id, watchId));
    await h.db.update(t.watches).set({ nextCheckAt: at }).where(eq(t.watches.id, watchId));
    return concierge().evaluateDueWatches(50);
  };
  const listing = (id: number, price: number, quantity: number, active = true) => ({ active, listing_id: id, price, quantity, quantity_start: quantity, row: '8', section: '215', zone: 'Upper' });

  const ARENA = '10000000-0000-4000-8000-0000000000e1';
  const TEAM = '20000000-0000-4000-8000-0000000000e1';
  const GAME = '30000000-0000-4000-8000-0000000000e1';
  beforeAll(async () => {
    h = await openTestDb();
    await h.db.insert(t.venues).values({ id: ARENA, name: 'Watch Garden', city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York' });
    await h.db.insert(t.entities).values({ id: TEAM, kind: 'team', name: 'Metro Watchers', slug: 'metro-watchers', aliases: ['Watchers'], league: 'NBA', homeVenueId: ARENA });
    await h.db.insert(t.events).values({ id: GAME, name: 'Metro Watchers vs. Boston', category: 'nba', venueId: ARENA, primaryEntityId: TEAM, isHome: true, localStartAt: new Date('2026-10-30T23:30:00Z'), status: 'scheduled', verifiedSourceId: 'ticketmaster', isFixture: false });
    // No seller can be monitored: SeatData is the only possible watch source, as in production.
    await h.db.update(t.adapterConfigs).set({ enabled: false });
    await h.db.insert(t.eventSourceMappings).values({ eventId: GAME, sourceId: 'ticketmaster', sourceEventId: 'TMWATCH1', authoritativeUrl: 'https://www.ticketmaster.com/x/event/TMWATCH1', role: 'discovery', confidence: 'provider_id' });
  });
  afterAll(async () => {
    await h.close();
  });


  beforeEach(async()=>{
    now=QA_NOW; listings=[]; failListings=false;
    await setLicence(['tracking','alerts']);
    await h.db.update(t.venues).set({country:'US'}).where(eq(t.venues.id,ARENA));
    await h.db.update(t.events).set({status:'scheduled',category:'nba'}).where(eq(t.events.id,GAME));
    await h.db.update(t.watches).set({nextCheckAt:new Date('2026-10-29T00:00:00Z')});
  });
  const create = async(text=ASK,over:Record<string,string>={})=>{
    seq++;const c=concierge(over);
    const requestId=await ask(c,text,`pw-${seq}@customer.example`);
    return {c,requestId,w:await watchFor(requestId)};
  };
  const evidence=async(label:string,w:typeof t.watches.$inferSelect|undefined,extra:Record<string,unknown>={})=>{
    captures.push({label,at:now.toISOString(),watch:w?await watchFor(w.requestId):null,alerts:w?await alertsFor(w.id):[],...extra});
  };
  const sendOver={APP_MODE:'live',EMAIL_SEND_ENABLED:'true',RESEND_API_KEY:'re_test_key',EXTRACTION_PROVIDER:'rules'};


  it('X01 provider outage retries at most three times; no further lookup before the next claimed slot',async()=>{
    const {w}=await create();failListings=true;const before=reads;
    await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    const row=(await watchFor(w!.requestId))!;failListings=false;listings=[listing(901,60,4)];
    now=new Date(row.nextCheckAt.getTime()-1);
    expect(await concierge().evaluateDueWatches()).toMatchObject({evaluated:0});expect(reads-before).toBe(3);
    now=row.nextCheckAt;const result=await concierge().evaluateDueWatches();
    await evidence('X01',w,{result,readsUsed:reads-before});expect(result.alertsCreated).toBe(1);expect(reads-before).toBe(4);
  });
  it('X02 superseded budget/party revision prevents approval of the old alert',async()=>{
    const {w,requestId}=await create();listings=[listing(902,60,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    const a=(await alertsFor(w!.id))[0]!;
    await h.db.update(t.requests).set({currentRevision:2}).where(eq(t.requests.id,requestId));
    const result=await concierge(sendOver,new RecordingProvider()).approveWatchAlert({alertId:a.id,reviewerUserId:'staff'});
    await evidence('X02',w,{result});expect(result).toMatchObject({ok:false,reason:'revision_superseded'});expect((await alertsFor(w!.id))[0]!.approvalState).toBe('invalidated');
  });
  it('X03 rights revoked after approval block dispatch without a second provider lookup',async()=>{
    const {w}=await create();listings=[listing(903,60,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    const a=(await alertsFor(w!.id))[0]!,provider=new RecordingProvider(),c=concierge(sendOver,provider);
    const approval=await c.approveWatchAlert({alertId:a.id,reviewerUserId:'staff'});expect(approval.ok).toBe(true);
    const before=reads;await setLicence(['tracking']);const result=await c.dispatchSend(approval.sendIntentId!);
    await evidence('X03',w,{result,providerSends:provider.sent.length,extraReads:reads-before});expect(result.outcome).toBe('blocked');expect(provider.sent).toHaveLength(0);expect(reads-before).toBe(0);
  });
  it('X04 a stale invalidated low price does not suppress a higher fresh first useful alert',async()=>{
    const {w}=await create(ASK.replace('$400','$520'));listings=[listing(904,50,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    const a=(await alertsFor(w!.id))[0]!;
    await h.db.update(t.watchAlerts).set({approvalState:'invalidated'}).where(eq(t.watchAlerts.id,a.id));
    listings=[listing(905,80,4)];const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+365*MIN));
    await evidence('X04',w,{result});expect(result.alertsCreated).toBe(1);expect((await alertsFor(w!.id)).some(x=>x.payableTotalCents===41600&&x.approvalState==='pending')).toBe(true);
  });
  it('X05 rolling cap includes exact 24h boundary then releases it one millisecond later',async()=>{
    const {w}=await create();listings=[listing(906,70,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    listings=[listing(907,50,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+365*MIN));
    listings=[listing(908,30,4)];const edge=new Date(QA_NOW.getTime()+(24*60+5)*MIN);
    expect((await evaluateAt(w!.id,edge)).alertsCreated).toBe(0);
    const result=await evaluateAt(w!.id,new Date(edge.getTime()+1));
    await evidence('X05',w,{result});expect(result.alertsCreated).toBe(1);expect(await alertsFor(w!.id)).toHaveLength(3);
  });
  it('X06 a new watch generation can alert on a price seen only in its old generation',async()=>{
    const {w}=await create();listings=[listing(909,60,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    await h.db.update(t.watches).set({generation:w!.generation+1}).where(eq(t.watches.id,w!.id));
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+365*MIN));
    await evidence('X06',w,{result});expect(result.alertsCreated).toBe(1);expect(await alertsFor(w!.id)).toHaveLength(2);
  });
  it('X07 after daily rollover a rise and return to the old low never masquerade as a new bargain',async()=>{
    const {w}=await create();listings=[listing(910,70,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    listings=[listing(911,50,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+365*MIN));
    listings=[listing(912,80,4)];expect((await evaluateAt(w!.id,new Date(QA_NOW.getTime()+31*60*MIN))).alertsCreated).toBe(0);
    listings=[listing(913,50,4)];expect((await evaluateAt(w!.id,new Date(QA_NOW.getTime()+37*60*MIN))).alertsCreated).toBe(0);
    listings=[listing(914,40,4)];const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+43*60*MIN));
    await evidence('X07',w,{result});expect(result.alertsCreated).toBe(1);
  });
  it('X08 postponed after approval cannot dispatch the previous date price',async()=>{
    const {w}=await create();listings=[listing(915,60,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    const a=(await alertsFor(w!.id))[0]!,provider=new RecordingProvider(),c=concierge(sendOver,provider);
    const approval=await c.approveWatchAlert({alertId:a.id,reviewerUserId:'staff'});expect(approval.ok).toBe(true);
    await h.db.update(t.events).set({status:'postponed'}).where(eq(t.events.id,GAME));
    const result=await c.dispatchSend(approval.sendIntentId!);await evidence('X08',w,{result,providerSends:provider.sent.length});expect(result.outcome).toBe('blocked');expect(provider.sent).toHaveLength(0);
  });

  it('X09 retry requests must not exceed a one-call daily API allowance',async()=>{
    const {w}=await create();failListings=true;
    // Disposable DB only: zero used calls, then a remaining budget of one.
    await h.db.delete(t.marketFetches);
    const before=reads;now=new Date(QA_NOW.getTime()+5*MIN);
    await h.db.update(t.watches).set({nextCheckAt:now}).where(eq(t.watches.id,w!.id));
    const result=await concierge({SEATDATA_DAILY_CALL_LIMIT:'1'}).evaluateDueWatches();
    const logs=await h.db.select().from(t.marketFetches);
    await evidence('X09',w,{result,readsUsed:reads-before,callAllowance:1,fetchLogs:logs});
    expect(reads-before).toBeLessThanOrEqual(1);
    // What was spent is what was logged, and the day's total never passes the allowance.
    expect(logs.reduce((n,l)=>n+l.calls,0)).toBeLessThanOrEqual(1);expect(result.alertsCreated).toBe(0);
  });
  it('X09 control: with room for them, the two retries still run (a retried 503 then a success)',async()=>{
    const {w}=await create();await h.db.delete(t.marketFetches);let fails=2;failListings=false;listings=[listing(950,60,4)];
    const flaky=(async(input:string)=>{const u=new URL(input);if(u.pathname==='/api/v0.1.1/listings/get'&&fails>0){fails-=1;reads+=1;return new Response('{}',{status:503});}return fetchImpl(input);}) as unknown as typeof fetch;
    now=new Date(QA_NOW.getTime()+5*MIN);await h.db.update(t.watches).set({nextCheckAt:new Date('2026-10-29T00:00:00Z')}).where(ne(t.watches.id,w!.id));await h.db.update(t.watches).set({nextCheckAt:now}).where(eq(t.watches.id,w!.id));
    const before=reads;const c=new Concierge({db:h.db,env:env({SEATDATA_DAILY_CALL_LIMIT:'3'}),extractor:new FixtureExtractor(),drafter:new FixtureDrafter(),clock:()=>now,emailProvider:null,marketFetch:flaky});
    const result=await c.evaluateDueWatches();
    expect(reads-before).toBe(3);expect(result.alertsCreated).toBe(1);
    const [log]=await h.db.select().from(t.marketFetches).where(and(eq(t.marketFetches.kind,'listings_watch'),eq(t.marketFetches.eventId,GAME)));
    expect(log).toMatchObject({status:'success',calls:3});
  });
  it('X09 control: with nothing left today, no attempt at all, and the read is logged as a budget stop',async()=>{
    const {w}=await create();failListings=true;await h.db.delete(t.marketFetches);
    await h.db.insert(t.marketFetches).values({provider:'seatdata',kind:'stats',eventId:null,status:'success',calls:1,points:0,at:new Date(QA_NOW.getTime()+MIN)});
    const before=reads;now=new Date(QA_NOW.getTime()+5*MIN);await h.db.update(t.watches).set({nextCheckAt:now}).where(eq(t.watches.id,w!.id));
    await concierge({SEATDATA_DAILY_CALL_LIMIT:'1'}).evaluateDueWatches();
    expect(reads-before).toBe(0);
  });
  it('X10 relative late-entry hard requirement blocks market watch without an exact clock time',async()=>{
    const {w,requestId}=await create(ASK+' I can only arrive after the show starts; late entry must be allowed. Do not suggest a ticket unless that entry rule is confirmed.');
    await evidence('X10',w,{requestId});expect(w).toBeUndefined();
    const audit=await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId,requestId),eq(t.auditLog.action,'watch.not_created')));
    expect(audit.map(a=>(a.diff as {reason:string}).reason).some(r=>/^(?:market_)?unverifiable:entry_rule$/.test(r))).toBe(true);
  });
});
