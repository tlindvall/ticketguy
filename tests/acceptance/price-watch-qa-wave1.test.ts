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
 * SeatData price watch QA, first wave (Oct 1 2026, merged #78 at 2f1bd19): the package's independent checks, ported
 * with its exact phrasings. On 2f1bd19, 39 pass and 8 fail (PW-REPEAT-KEY-01, PW-SECTIONS-01, PW-ENTRY-01,
 * PW-SCHEDULER-CLAIM-01, PW-REPEAT-CONTRACT-01). The re-alert contract is the larger of $10 and 5% (DECISION_LOG #63),
 * so the package's "OR" rows are restated for it; the rest are kept and tightened (exact audit reasons, more controls).
 *
 * A price watch on SeatData's resale listings (DECISION_LOG #62), against a fake SeatData shaped like its payloads:
 * "4 together for less than $400, alert me". No seller can be monitored, as in production. The watch exists only
 * when the licence allows alerts (or tracking while email goes only to the owner's testers); each look is one
 * listings read; an alert is a heads-up on listed prices with the fee allowance said, approved by staff, and as
 * fresh as the read behind it.
 */
import { alertDedupeKey, shouldAlertMarket, marketWatchable, constraintBasket } from '@/lib/domain/watches';
const MIN = 60_000;
const QA_NOW = new Date('2026-10-01T20:00:00Z');
const KEY = 'ab'.repeat(32);

describe('independent price watch QA contracts', () => {
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

  it('PW-07 fees turn a base-price fit into no alert',async()=>{
    const {w}=await create();listings=[listing(100,100,4)];
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    await evidence('PW-07',w,{result});expect(result.alertsCreated).toBe(0);
  });
  it('PW-08 inclusive target qualifies at exactly $520',async()=>{
    const {w}=await create(ASK.replace('$400','$520'));listings=[listing(101,100,4)];
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    await evidence('PW-08',w,{result});expect(result.alertsCreated).toBe(1);
    expect((await alertsFor(w!.id))[0]!.payableTotalCents).toBe(52000);
  });
  it.each([[76.92,1],[76.93,0]])('PW-09 $%s boundary gives %s alerts',async(price,expected)=>{
    const {w}=await create();listings=[listing(102,price,4)];
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    await evidence('PW-09',w,{price,result});expect(result.alertsCreated).toBe(expected);
  });
  it('PW-10/13 cheap restricted products never set ordinary group price',async()=>{
    const {w}=await create();listings=[{...listing(103,1,4),section:'Wheelchair ADA'}, {...listing(104,2,4),section:'Suite'}, {...listing(105,3,4),section:'Parking'},listing(106,50,2),listing(107,30,6,false),listing(108,75,4),listing(109,82,6)];
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    await evidence('PW-10/13',w,{result});
    expect((await alertsFor(w!.id))[0]!.market).toMatchObject({listedPerTicketCents:7500,listings:2,estimatedTotalCents:39000});
  });
  it.each([[2,5000,2],[6,9000,1]])('PW-11 party %s chooses eligible size',async(quantity,price,count)=>{
    const {w}=await create(ASK.replace('4 tickets',`${quantity} tickets`).replace('$400','$1500'));
    listings=[listing(110,50,4),listing(111,90,6)];
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    await evidence('PW-11',w,{quantity,result});
    expect((await alertsFor(w!.id))[0]!.market).toMatchObject({listedPerTicketCents:price,listings:count,basis:`${quantity}+`});
  });
  it('PW-12 null/zero/negative quantities and prices do not create a bargain',async()=>{
    const {w}=await create();listings=[{...listing(112,1,4),quantity:null},listing(113,-1,4),listing(114,0,4),listing(115,1,0),{...listing(116,1,4),price:'garbage'},listing(117,75,4)];
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    await evidence('PW-12',w,{result});expect((await alertsFor(w!.id))[0]!.market).toMatchObject({listedPerTicketCents:7500,listings:1});
  });
  it('PW-14 first check and subsequent cadence gate paid reads',async()=>{
    const {w}=await create();listings=[listing(118,75,4)];const before=reads;
    now=new Date(QA_NOW.getTime()+5*MIN-1);
    expect(await concierge().evaluateDueWatches()).toMatchObject({evaluated:0});expect(reads-before).toBe(0);
    now=new Date(QA_NOW.getTime()+5*MIN);
    expect(await concierge().evaluateDueWatches()).toMatchObject({evaluated:1,alertsCreated:1});
    const row=(await watchFor(w!.requestId))!;
    expect(row.nextCheckAt.getTime()-now.getTime()).toBeGreaterThanOrEqual(180*MIN);
    now=new Date(row.nextCheckAt.getTime()-1);expect(await concierge().evaluateDueWatches()).toMatchObject({evaluated:0});
    await evidence('PW-14',w,{readsUsed:reads-before});expect(reads-before).toBe(1);
  });
  it('PW-15 concurrent due evaluators claim only one paid read',async()=>{
    const {w}=await create();listings=[listing(119,75,4)];now=new Date(QA_NOW.getTime()+5*MIN);const before=reads;
    const result=await Promise.all([concierge().evaluateDueWatches(),concierge().evaluateDueWatches()]);
    await evidence('PW-15',w,{result,readsUsed:reads-before});expect(reads-before).toBe(1);
    expect((await alertsFor(w!.id)).length).toBe(1);
    // What the ticks report is what was stored: one evaluation, one alert, across both.
    expect(result.reduce((n,r)=>n+r.alertsCreated,0)).toBe(1);expect(result.reduce((n,r)=>n+r.evaluated,0)).toBe(1);
  });
  it('PW-16 pending alert is not a queued send before approval',async()=>{
    const {w,requestId}=await create();listings=[listing(120,75,4)];
    await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    const intents=await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId,requestId));
    await evidence('PW-16',w,{intents});
    expect(intents.filter(i=>i.messageClass==='watch_alert')).toHaveLength(0);
    expect((await alertsFor(w!.id))[0]!.approvalState).toBe('pending');
  });
  it.each([[180*MIN,true],[180*MIN+1,false]])('PW-17 approval at age %s ms has fresh=%s',async(age,fresh)=>{
    const {w}=await create();listings=[listing(121,75,4)];const at=new Date(QA_NOW.getTime()+5*MIN);
    await evaluateAt(w!.id,at);const a=(await alertsFor(w!.id))[0]!;now=new Date(at.getTime()+age);
    const approval=await concierge(sendOver,new RecordingProvider()).approveWatchAlert({alertId:a.id,reviewerUserId:'staff'});
    await evidence('PW-17',w,{age,approval});expect(approval.ok).toBe(fresh);
    if(!fresh)expect(approval.reason).toBe('stale_observation');expect((await watchFor(w!.requestId))!.state).toBe('active');
  });
  it('PW-18 stale at dispatch is blocked even after fresh approval',async()=>{
    const {w}=await create();listings=[listing(122,75,4)];const at=new Date(QA_NOW.getTime()+5*MIN);
    await evaluateAt(w!.id,at);const a=(await alertsFor(w!.id))[0]!;now=new Date(at.getTime()+MIN);
    const provider=new RecordingProvider(),c=concierge(sendOver,provider);
    const approved=await c.approveWatchAlert({alertId:a.id,reviewerUserId:'staff'});expect(approved.ok).toBe(true);
    now=new Date(at.getTime()+181*MIN);const result=await c.dispatchSend(approved.sendIntentId!);
    await evidence('PW-18',w,{approved,result,providerSends:provider.sent.length});expect(result).toMatchObject({outcome:'blocked',reasons:['evidence_stale']});expect(provider.sent).toHaveLength(0);
  });
  it('PW-20 same market price is deduplicated',async()=>{
    const {w}=await create();listings=[listing(123,75,4)];
    await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+4*60*MIN));
    await evidence('PW-20',w,{result});expect(result.alertsCreated).toBe(0);expect(await alertsFor(w!.id)).toHaveLength(1);
  });
  it('PW-21 material market drop $390→$260 must produce a second alert',async()=>{
    const {w}=await create();listings=[listing(124,75,4)];
    await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    listings=[listing(125,50,4)];const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+4*60*MIN));
    await evidence('PW-21-material-drop',w,{result,expectedEstimateCents:26000});expect(result.alertsCreated).toBe(1);expect(await alertsFor(w!.id)).toHaveLength(2);
  });
  it('PW-21 distinct $390 and $260 estimates need distinct duplicate keys',()=>{
    const common={watchId:'w',generation:1,offerIdentity:'market:4+'};
    const high=alertDedupeKey({...common,totalCents:39000}),low=alertDedupeKey({...common,totalCents:26000});
    captures.push({label:'PW-21-key',high,low});expect(high).not.toBe(low);
  });
  // PW-REPEAT-CONTRACT-01: a repeat needs at least $10 AND at least 5% off the lowest alerted total (the larger of
  // the two). $120 → $114 is 5% but only $6, so no; $200 → $190 is both; $400 → $391 is $9, under $20 (5%).
  it.each([[20000,19000,true],[12000,11400,false],[12000,11000,true],[40000,39100,false],[40000,38000,true],[100000,80000,true],[12000,11401,false]])('PW-21 re-alert contract (larger of $10 and 5%%) %s→%s alert=%s',async(last,next,expected)=>{
    const result=shouldAlertMarket({targetTotalCents:150000,estimatedTotalCents:next,observedAt:QA_NOW,now:QA_NOW,lastAlertedTotalCents:last,alertsInLast24h:1,dedupeKeyExists:false});
    captures.push({label:'PW-21-contract',last,next,expected,result});expect(result.alert).toBe(expected);
  });
  it('PW-21 a high-budget drop $1000→$800 is a new key and a new alert',async()=>{
    const {w}=await create(ASK.replace('$400','$1200'));listings=[listing(140,192.31,4)];
    await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    listings=[listing(141,153.85,4)];const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+4*60*MIN));
    expect(result.alertsCreated).toBe(1);expect((await alertsFor(w!.id)).map(a=>Math.round(a.payableTotalCents/100)).sort((x,y)=>x-y)).toEqual([800,1000]);
  });
  it('PW-21 a rise, then a return to the earlier low, never re-alerts; a later small dip under it doesn’t either',async()=>{
    const {w}=await create();listings=[listing(142,50,4)];
    await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));
    listings=[listing(143,70,4)];expect((await evaluateAt(w!.id,new Date(QA_NOW.getTime()+4*60*MIN))).alertsCreated).toBe(0);
    listings=[listing(144,50,4)];expect((await evaluateAt(w!.id,new Date(QA_NOW.getTime()+8*60*MIN))).alertsCreated).toBe(0);
    // A day later the daily window is empty, but the baseline is still the $260 already alerted: $256 isn't $13 better.
    listings=[listing(145,49.25,4)];expect((await evaluateAt(w!.id,new Date(QA_NOW.getTime()+30*60*MIN))).alertsCreated).toBe(0);
    expect(await alertsFor(w!.id)).toHaveLength(1);
  });
  it('PW-21 a new generation (a changed request) starts a fresh baseline and fresh keys',()=>{
    const common={watchId:'w',offerIdentity:'market:4+',totalCents:39000};
    expect(alertDedupeKey({...common,generation:1})).not.toBe(alertDedupeKey({...common,generation:2}));
    expect(alertDedupeKey({...common,generation:1})).toBe(alertDedupeKey({...common,generation:1}));
  });
  it('PW-22 rolling last24h cap preserves two but rejects third',()=>{
    const result=shouldAlertMarket({targetTotalCents:50000,estimatedTotalCents:10000,observedAt:QA_NOW,now:QA_NOW,lastAlertedTotalCents:20000,alertsInLast24h:2,dedupeKeyExists:false});
    captures.push({label:'PW-22-domain-cap',result});expect(result).toMatchObject({alert:false,reason:'daily_alert_cap'});
  });
  it('PW-24 cancel invalidates pending alert and leaves another watch active',async()=>{
    const one=await create(),two=await create();listings=[listing(126,75,4)];
    await evaluateAt(one.w!.id,new Date(QA_NOW.getTime()+5*MIN));
    await concierge().cancelWatch({watchId:one.w!.id,actor:'staff',reason:'synthetic scoped cancel'});
    await evidence('PW-24',one.w,{otherWatch:await watchFor(two.requestId)});
    expect((await watchFor(one.requestId))!.state).toBe('cancelled');expect((await alertsFor(one.w!.id))[0]!.approvalState).toBe('invalidated');expect((await watchFor(two.requestId))!.state).toBe('active');
  });
  it('PW-25 cancel after approval blocks queued dispatch',async()=>{
    const {w}=await create();listings=[listing(127,75,4)];
    await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));const a=(await alertsFor(w!.id))[0]!;
    const provider=new RecordingProvider(),c=concierge(sendOver,provider);const approval=await c.approveWatchAlert({alertId:a.id,reviewerUserId:'staff'});expect(approval.ok).toBe(true);
    await c.cancelWatch({watchId:w!.id,actor:'staff',reason:'stop'});const result=await c.dispatchSend(approval.sendIntentId!);
    await evidence('PW-25',w,{approval,result,providerSends:provider.sent.length});expect(provider.sent).toHaveLength(0);expect(result.outcome).not.toBe('sent');
  });
  it('PW-27 expired watch stops without a listings read',async()=>{
    const {w}=await create();now=new Date(w!.expiresAt.getTime()+1);await h.db.update(t.watches).set({nextCheckAt:now}).where(eq(t.watches.id,w!.id));const before=reads;
    const result=await concierge().evaluateDueWatches();await evidence('PW-27-expiry',w,{result,readsUsed:reads-before});expect(reads-before).toBe(0);expect((await watchFor(w!.requestId))!.state).toBe('expired');
  });
  it('PW-27 cancelled event pauses without a listings read',async()=>{
    const {w}=await create();await h.db.update(t.events).set({status:'cancelled'}).where(eq(t.events.id,GAME));const before=reads;
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));await evidence('PW-27-cancelled',w,{result,readsUsed:reads-before});expect(reads-before).toBe(0);expect((await watchFor(w!.requestId))!.pauseReason).toBe('event_cancelled');
  });
  it.each([['PW-28','wheelchair accessible seating needed','accessible_seating'],['PW-29','only sections 101–105','sections'],['PW-30','tickets must arrive by noon','delivery_deadline'],['PW-31-age','must allow my 16-year-old','age_rule'],['PW-31-entry','must permit entry after midnight','entry_rule']])('%s unsupported requirement never creates market watch',async(label,constraint,reason)=>{
    const {w,requestId}=await create(ASK+' '+constraint+'.');
    const audit=await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId,requestId),eq(t.auditLog.action,'watch.not_created')));
    await evidence(label,w,{requestId,constraint,audit,expectedReason:reason});expect(w).toBeUndefined();
    // An entry rule with a time in it is answered by the late-entry reply first (PW-ENTRY-REPLY-02), which audits
    // unverifiable:entry_rule; every other requirement reaches the watch gate.
    const reasons=audit.map(a=>(a.diff as {reason:string}).reason);
    expect(reason==='entry_rule'?reasons.some(r=>/^(?:market_)?unverifiable:entry_rule$/.test(r)):reasons.includes(`market_unverifiable:${reason}`)).toBe(true);
  });
  it.each([['en dash range','Only sections 101–105.'],['through','Sections 101 through 105 only.'],['comma list','Only sections 101, 102 or 110.'],['must be in','We must be in section 212.']])('PW-29 %s never creates a market watch',async(_l,constraint)=>{
    const {w,requestId}=await create(ASK+' '+constraint);
    const audit=await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId,requestId),eq(t.auditLog.action,'watch.not_created')));
    expect(w).toBeUndefined();expect(audit.map(a=>(a.diff as {reason:string}).reason)).toContain('market_unverifiable:sections');
  });
  it.each([['a preference','Ideally section 101 if possible.'],['a later "any section is fine"','Only sections 101–105. Actually any section is fine.'],['no section at all','']])('PW-29 control: %s still gets a watch',async(_l,extra)=>{
    const {w}=await create(`${ASK} ${extra}`.trim());expect(w).toBeDefined();expect((w!.constraints as {acceptableSections:string[]|null}).acceptableSections).toBeNull();
  });
  it('PW-32 explicit no accessibility need does not become a positive need',async()=>{
    const {w,requestId}=await create(ASK+' Neither of us needs wheelchair accessible seating.');
    await evidence('PW-32',w,{requestId});expect(w).toBeDefined();
  });
  it.each([['switch',{WATCH_SEND_ENABLED:'false'}],['API key',{SEATDATA_API_KEY:''}]])('PW-36 missing %s means no market watch',async(label,over)=>{
    const {w,requestId}=await create(ASK,over);await evidence('PW-36',w,{requestId,gate:label});expect(w).toBeUndefined();
  });
  it('PW-36 tester allowlist permits tracking-only internal watch',async()=>{
    await setLicence(['tracking']);const {w}=await create(ASK,{EMAIL_TEST_RECIPIENT_ALLOWLIST:'pw-tester@customer.example'});
    await evidence('PW-36-internal-allowlist',w);expect(w).toBeDefined();
  });
  it('PW-37 revoked licence pauses without paid read',async()=>{
    const {w}=await create();await setLicence(['tracking']);const before=reads;
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));await evidence('PW-37',w,{result,readsUsed:reads-before});expect(reads-before).toBe(0);expect((await watchFor(w!.requestId))!.state).toBe('paused');
  });
  it('PW-39 provider503 creates no bargain and logs failure',async()=>{
    const {w}=await create();failListings=true;
    const result=await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));await evidence('PW-39',w,{result});expect(result.alertsCreated).toBe(0);expect(await alertsFor(w!.id)).toHaveLength(0);
    const logs=await h.db.select().from(t.marketFetches).where(and(eq(t.marketFetches.eventId,GAME),eq(t.marketFetches.kind,'listings_watch')));expect(logs.some(l=>l.status==='error')).toBe(true);
  });
  it('PW-41 creation and market-alert email disclose limits with no buy link',async()=>{
    const {w,c,requestId}=await create();await c.research({requestId,revision:1});const rec=(await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId,requestId)))[0]!;
    listings=[listing(128,75,4)];await evaluateAt(w!.id,new Date(QA_NOW.getTime()+5*MIN));const a=(await alertsFor(w!.id))[0]!;
    const approval=await concierge(sendOver,new RecordingProvider()).approveWatchAlert({alertId:a.id,reviewerUserId:'staff'});const intent=(await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.id,approval.sendIntentId!)))[0]!;
    await evidence('PW-41',w,{creationText:rec.bodyText,creationHtml:rec.bodyHtml,alertText:intent.bodyText,alertHtml:intent.bodyHtml,subject:intent.subject});
    expect(rec.bodyText).toContain('using an assumed 30% for fees (checkout fees can be higher)');expect(rec.bodyText).not.toMatch(/I can’t see live resale listings/);expect(intent.bodyText).toContain('about $390');expect(intent.bodyText).toContain('check the all-in price at checkout');
    expect(intent.bodyText).not.toMatch(/SeatData|found them|guaranteed|verified|https?:\/\//i);
    expect(intent.bodyHtml).not.toMatch(/<a\b[^>]*href=/i);
    expect(intent.bodyText).not.toContain('link you to the seller');expect(intent.bodyHtml).toContain('<strong>about $390 for four</strong>');
  });

  it.each([['PW-02','Watchers Oct 30, 4 tickets together. Please watch this for me.'],['PW-03','Watchers Oct 30, $400 total including fees. Please watch this for me.'],['PW-04','Watchers Oct 30, 4 tickets together, $400 total including fees. Is that a good deal?']])('%s missing prerequisite never silently creates watch',async(label,text)=>{
    const {w,requestId}=await create(text);await evidence(label,w,{text,requestId});expect(w).toBeUndefined();
  });
  it('PW-29 explicit canonical section requirement is blocked by domain helper',()=>{
    const b=constraintBasket({togetherRequired:true,budgetCents:40000,budgetBasis:'whole_party',accessibilityNeeds:null},4,new Date('2026-10-30T23:30:00Z'),{acceptableSections:['101','102']});
    const result=marketWatchable(b);captures.push({label:'PW-29-helper-control',basket:b,result});expect(result).toBe('sections');
  });
  it('PW-29 parsed seatingPreference still must become a hard watch constraint',async()=>{
    const extractor={name:'qa-canonical-preference',extract:async(input:Parameters<FixtureExtractor['extract']>[0])=>({...await new FixtureExtractor().extract(input),seatingPreference:'Only sections 101 through 105'})};
    const c=new Concierge({db:h.db,env:env(),extractor,drafter:new FixtureDrafter(),clock:()=>now,emailProvider:null,marketFetch:fetchImpl});
    const requestId=await ask(c,ASK+' Only sections 101 through 105.',`section-normalized@customer.example`);const w=await watchFor(requestId);
    await evidence('PW-29-canonical-preference',w,{requestId});expect(w).toBeUndefined();
  });
  it.each(['I can only arrive after midnight; entry then must be allowed.','Late entry is required; I cannot enter before midnight.'])('PW-31 entry wording variation: %s',async(constraint)=>{
    const {w,requestId}=await create(ASK+' '+constraint);await evidence('PW-31-entry-variation',w,{requestId,constraint});expect(w).toBeUndefined();
    const audit=await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.entityId,requestId),eq(t.auditLog.action,'watch.not_created')));
    // The watch path says market_unverifiable; the late-entry route, which answers an arrival time first, says
    // unverifiable. Either way it's the entry rule, audited, never a silent no-watch.
    expect(audit.map(a=>(a.diff as {reason:string}).reason).some(r=>/^(?:market_)?unverifiable:entry_rule$/.test(r))).toBe(true);
  });
  it('PW-31 the late-entry reply tells them no watch was set up, once',async()=>{
    const {requestId}=await create(ASK+' I can only arrive after midnight; entry then must be allowed.');
    const [send]=await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId,requestId));
    expect(send!.bodyText).toContain('Midnight entry is unverified.');
    expect(send!.bodyText.match(/I haven’t set up a price watch for this: listings don’t show whether a ticket admits people arriving at midnight/g)).toHaveLength(1);
    expect(send!.bodyText).not.toMatch(/I'm watching|I’m watching/);
  });
  it.each([['a quoted doors and start time','Doors open at 6pm and tip-off is 7:30pm.'],['no late entry needed','Late entry is required. Actually we don’t need late entry after all.']])('PW-31 control: %s is no entry rule, so the watch is created',async(_l,extra)=>{
    const {w}=await create(`${ASK} ${extra}`);expect(w).toBeDefined();expect((w!.constraints as {unverifiable:string[]}).unverifiable).toEqual([]);
  });
  it('PW-34 Guide depth is not eligible for a market watch in enforce mode',async()=>{
    await h.db.update(t.events).set({category:'classical'}).where(eq(t.events.id,GAME));
    const {w,requestId}=await create(ASK,{SERVICE_POLICY_MODE:'enforce'});await evidence('PW-34',w,{requestId});expect(w).toBeUndefined();
  });
  it('PW-35 non-US occurrence cannot create US-only watch',async()=>{
    await h.db.update(t.venues).set({country:'UK'}).where(eq(t.venues.id,ARENA));
    const {w,requestId}=await create();await evidence('PW-35',w,{requestId});expect(w).toBeUndefined();
  });
});
