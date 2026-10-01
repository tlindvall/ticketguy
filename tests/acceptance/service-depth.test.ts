import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbHandle } from '@/lib/db';
import * as t from '@/lib/db/schema';
import type { Env } from '@/lib/config/env';
import type { Offer } from '@/lib/domain/types';
import { openTestDb, inbound, testEnv, RecordingProvider } from '../harness';
import { Concierge } from '@/lib/intake/pipeline';
import { FixtureExtractor } from '@/lib/ai/extraction';
import { FixtureDrafter } from '@/lib/ai/drafting';
import { FIXTURE_NOW, FIXTURE_OFFERS, FX } from '@/lib/fixtures';
import { leaseDueOutbox, markDispatched } from '@/lib/intake/outbox';
import { MarketTracker } from '@/lib/market/tracker';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { compareOffers } from '@/lib/domain/comparison';
import { reconcileServiceDepth } from '@/lib/intake/reconcile-service-depth';

/**
 * The service-depth policy end to end under SERVICE_POLICY_MODE=enforce (DECISION_LOG #61). Each scenario
 * checks the customer's reply AND the work that did or didn't happen: adapter searches (counted on the
 * fixture adapter), SeatData calls (counted on a fake fetch), research runs, tracked events, watches and alerts.
 * Every send is captured locally; nothing reaches a real provider.
 */

const id = (n: number) => `9d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const V = { geffen: id(1), museum: id(2), javits: id(3), rodgers: id(4), club: id(5), dome: id(6), ubs: id(7) };
const E = { phil: id(101), museum: id(102), expo: id(103), hamilton: id(104), clubNight: id(105), arenaShow: id(106), cuse: id(107), testers: id(108), london: id(109) };
const ENT = { phil: id(201), museum: id(202), expo: id(203), hamilton: id(204), peggy: id(205), fred: id(206), cuse: id(207), testers: id(208) };
const NIL = '00000000-0000-4000-8000-000000000000';
const OVERRIDE_UNTIL = new Date(FIXTURE_NOW.getTime() + 5 * 60_000);

const at = (iso: string) => new Date(iso);
const offer = (over: Partial<Offer> & { id: string; eventId: string; payableTotalCents: number }): Offer => ({
  sourceId: FX.source, providerListingId: over.id, observedAt: FIXTURE_NOW.toISOString(), providerUpdatedAt: null, expiresAt: null, currency: 'USD', quantity: 2,
  baseTotalCents: Math.round(over.payableTotalCents * 0.82), mandatoryFeeTotalCents: over.payableTotalCents - Math.round(over.payableTotalCents * 0.82), taxTotalCents: 0, deliveryTotalCents: 0,
  priceCompleteness: 'verified_total', section: '101', row: 'A', seatNumbers: null, seatsTogether: true, admissionType: 'reserved', restrictions: [], deliveryMethod: 'mobile_transfer',
  expectedDeliveryAt: null, directPurchaseUrl: `https://example.invalid/sd/${over.id}`, affiliateUrl: null, affiliateCommissionBps: 0, evidenceId: `sd-ev-${over.id}`, collectionMode: 'fixture', availability: 'available', seatClass: 'upper', ...over,
} as Offer);

// Offers for every seeded event, so a source that runs finds something and a source that doesn't is visible.
const OFFERS: Record<string, Offer[]> = {
  ...FIXTURE_OFFERS,
  [E.phil]: [offer({ id: 'phil-2', eventId: E.phil, payableTotalCents: 18000 })],
  [E.museum]: [offer({ id: 'museum-2', eventId: E.museum, payableTotalCents: 6000 })],
  [E.expo]: [offer({ id: 'expo-2', eventId: E.expo, payableTotalCents: 9000 })],
  [E.hamilton]: [offer({ id: 'ham-2', eventId: E.hamilton, payableTotalCents: 45000 })],
  [E.clubNight]: [offer({ id: 'club-2', eventId: E.clubNight, payableTotalCents: 8000 })],
  [E.arenaShow]: [offer({ id: 'arena-2', eventId: E.arenaShow, payableTotalCents: 22000 })],
  [E.cuse]: [offer({ id: 'cuse-2', eventId: E.cuse, payableTotalCents: 12000 })],
  // Ordinary seats under the target: the bait for a watch that has lost its accessibility requirement (F04).
  [FX.events.knicks]: [offer({ id: 'knicks-ordinary', eventId: FX.events.knicks, payableTotalCents: 20000 })],
};

async function seed(h: DbHandle) {
  await h.db.insert(t.venues).values([
    { id: V.geffen, name: 'David Geffen Hall', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v1' },
    { id: V.museum, name: 'Brooklyn Museum', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v1' },
    { id: V.javits, name: 'Javits Center', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v1' },
    { id: V.rodgers, name: 'Richard Rodgers Theatre', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v1' },
    { id: V.club, name: 'Le Bain Club', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v1' },
    { id: V.dome, name: 'JMA Wireless Dome', aliases: [], city: 'Syracuse', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v1' },
    { id: V.ubs, name: 'UBS Arena', aliases: [], city: 'Elmont', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v1' },
  ]);
  await h.db.insert(t.entities).values([
    { id: ENT.phil, kind: 'performer', name: 'New York Philharmonic', slug: 'sd-new-york-philharmonic', aliases: ['NY Phil'] },
    { id: ENT.museum, kind: 'performer', name: 'Museum of Ice Cream', slug: 'sd-museum-of-ice-cream', aliases: [] },
    { id: ENT.expo, kind: 'performer', name: 'Mystery Expo', slug: 'sd-mystery-expo', aliases: [] },
    { id: ENT.hamilton, kind: 'production', name: 'Hamilton', slug: 'sd-hamilton', aliases: [] },
    { id: ENT.peggy, kind: 'performer', name: 'Peggy Gou', slug: 'sd-peggy-gou', aliases: [] },
    { id: ENT.fred, kind: 'performer', name: 'Fred again', slug: 'sd-fred-again', aliases: ['Fred again..'] },
    { id: ENT.cuse, kind: 'team', name: 'Syracuse Orange', slug: 'sd-syracuse-orange', aliases: ['Syracuse'] },
    { id: ENT.testers, kind: 'team', name: 'Long Island Testers', slug: 'sd-long-island-testers', aliases: ['Testers'], league: 'NHL' },
  ]);
  const ev = (eid: string, name: string, category: string, venueId: string, entityId: string, start: string, isFixture = true): typeof t.events.$inferInsert => ({ id: eid, name, category, venueId, primaryEntityId: entityId, localStartAt: at(start), status: 'scheduled', verifiedSourceId: 'fixture', isFixture });
  await h.db.insert(t.events).values([
    ev(E.phil, 'New York Philharmonic: Mahler 5', 'classical', V.geffen, ENT.phil, '2026-10-10T23:30:00Z'),
    ev(E.museum, 'Museum of Ice Cream timed entry', 'attractions', V.museum, ENT.museum, '2026-10-11T15:00:00Z'),
    ev(E.expo, 'Mystery Expo', 'unknown', V.javits, ENT.expo, '2026-10-12T15:00:00Z'),
    ev(E.hamilton, 'Hamilton', 'broadway', V.rodgers, ENT.hamilton, '2026-10-13T23:00:00Z'),
    ev(E.clubNight, 'Peggy Gou (DJ set)', 'electronic_nightlife', V.club, ENT.peggy, '2026-10-14T03:00:00Z'),
    ev(E.arenaShow, 'Fred again..', 'electronic_nightlife', FX.venues.msg, ENT.fred, '2026-10-16T00:00:00Z'),
    ev(E.cuse, 'Syracuse Orange vs. Duke Blue Devils', 'ncaa_regular', V.dome, ENT.cuse, '2026-10-17T23:00:00Z'),
    // A real-world event (not fixture) no monitoring source has ever mapped (SD11).
    ev(E.testers, 'Long Island Testers vs. Visitors', 'nhl', V.ubs, ENT.testers, '2026-10-18T23:00:00Z', false),
  ]);
  // SeatData approved for tracking and advice, so only the service-depth gate stands between a request and a call.
  await h.db.update(t.marketDatasets).set({ status: 'approved', approvedUses: ['tracking', 'benchmark', 'advice', 'customer_display'], licenseReference: 'test' }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
}

describe('service-depth policy, enforced', () => {
  let h: DbHandle;
  let now = FIXTURE_NOW;
  const searches: string[] = [];
  const marketCalls: string[] = [];
  const marketFetch = (async (input: string) => {
    marketCalls.push(new URL(input).pathname);
    return new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }), { status: 200 });
  }) as unknown as typeof fetch;
  // Every adapter search reads its event's offers from here: the count is the number of searches per event.
  const fixtureOffers = new Proxy(OFFERS, { get: (target, prop: string) => { if (prop in target) searches.push(prop); return target[prop]; } });
  const env = (over: Record<string, string> = {}): Env => testEnv({
    SERVICE_POLICY_MODE: 'enforce', WATCH_SEND_ENABLED: 'true', SEATDATA_API_KEY: 'ab'.repeat(32), EMAIL_TEST_RECIPIENT_ALLOWLIST: 'sd-tester@customer.example',
    SERVICE_DEPTH_OVERRIDES: JSON.stringify([{ id: 'ovr-cuse', depth: 'core', eventIds: [E.cuse], owner: 'staff@ticketguy.test', reason: 'Selected rivalry game (test)', expiresAt: OVERRIDE_UNTIL.toISOString(), evidence: 'service-depth acceptance test' }]),
    ...over,
  });
  const concierge = (e: Env = env()) => new Concierge({ db: h.db, env: e, extractor: new FixtureExtractor(), drafter: new FixtureDrafter(), clock: () => now, emailProvider: new RecordingProvider(), fixtureOffers, marketFetch });

  const drain = async (c: Concierge) => {
    for (let i = 0; i < 10; i++) {
      const leased = (await leaseDueOutbox(h.db, { limit: 50, now })).filter((e) => e.eventType === 'request.interpret' || e.eventType === 'research.requested');
      if (!leased.length) return;
      for (const ev of leased) {
        const p = ev.payload as Record<string, string>;
        if (ev.eventType === 'request.interpret') await c.interpret({ messageId: p.messageId!, requestId: p.requestId! });
        else await c.research({ requestId: p.requestId!, revision: Number(ev.payload.revision) });
        await markDispatched(h.db, ev.id, ev.leaseToken, now);
      }
    }
  };
  let seq = 0;
  const ask = async (text: string, opts: { e?: Env; subject?: string; from?: string; requestFollowUp?: string } = {}) => {
    const c = concierge(opts.e);
    seq += 1;
    const from = opts.from ?? `sd-${seq}@customer.example`;
    const r = (await c.ingestInbound(inbound({ text, from, subject: opts.subject ?? `SD ${seq}` }))) as { requestId: string };
    await drain(c);
    return { c, requestId: r.requestId, from };
  };
  const repliesTo = async (requestId: string) => (await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.requestId, requestId))).map((s) => ({ text: s.bodyText, html: s.bodyHtml, cls: s.messageClass }));
  const work = async (requestId: string, eventId: string) => ({
    searches: searches.filter((x) => x === eventId).length,
    tracked: (await h.db.select().from(t.trackedEvents).where(eq(t.trackedEvents.eventId, eventId))).length,
    watches: (await h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId))).length,
    staff: (await h.db.select().from(t.requestOutcomes).where(and(eq(t.requestOutcomes.requestId, requestId), eq(t.requestOutcomes.kind, 'staff_comparison_offered')))).length,
    runs: await h.db.select().from(t.researchRuns).where(eq(t.researchRuns.requestId, requestId)),
    adviceRuns: await h.db.select().from(t.adviceRuns).where(eq(t.adviceRuns.requestId, requestId)),
  });

  beforeAll(async () => {
    h = await openTestDb();
    await seed(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    now = FIXTURE_NOW;
  });

  const versionPolicy = async (requestId: string) => (await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId)).orderBy(t.requestVersions.revision)).at(-1)?.servicePolicy as { depth: string; category: string; format: string | null; allowedOperations: string[]; reasons: string[] } | null;

  it('SD04/SD28: an unknown or blocked event gets the official route, no marketplace sweep and no adapter search', async () => {
    for (const [text, eventId, category] of [['2 tickets to Mystery Expo on Oct 12', E.expo, 'unknown'], ['2 tickets to the Museum of Ice Cream on Oct 11', E.museum, 'attractions']] as const) {
      const before = marketCalls.length;
      const { requestId } = await ask(text);
      const w = await work(requestId, eventId);
      expect(w.searches).toBe(0);
      expect(w.tracked).toBe(0);
      expect(w.runs).toHaveLength(0);
      expect(marketCalls.length).toBe(before);
      expect((await versionPolicy(requestId))!.category).toBe(category);
      const [reply] = await repliesTo(requestId);
      expect(reply!.text).toContain('the official seller is the venue’s own box office or ticket page');
      expect(reply!.cls).not.toBe('clarification');
    }
    expect((await versionPolicy((await ask('2 tickets to the Museum of Ice Cream on Oct 11')).requestId))!.reasons).toContain('operator_blocked');
    // Lifting the operator block doesn't make the museum a research project: Guide still runs no search.
    const { requestId } = await ask('2 tickets to the Museum of Ice Cream on Oct 11', { e: env({ BLOCKED_CATEGORIES: '' }) });
    const w = await work(requestId, E.museum);
    expect(w.searches).toBe(0);
    expect(w.runs).toHaveLength(0);
    expect(await versionPolicy(requestId)).toMatchObject({ depth: 'guide', allowedOperations: ['official_lookup', 'provided_offer_check'] });
  });

  it('SD05: a food festival gets bounded supplied arithmetic, with no sweep, tracking, history or watch', async () => {
    const { requestId } = await ask('Two of us for the Brooklyn Wine Festival on Saturday. Offer A: general admission $65 each including fees, 10 tastings. Offer B: VIP $110 each including fees, unlimited tastings and early entry. Which is better value?');
    const replies = await repliesTo(requestId);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toMatch(/\$130|\$220/);
    const [ver] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId));
    expect((ver!.servicePolicy as { category: string; depth: string })).toMatchObject({ category: 'food_drink', depth: 'guide' });
    const w = await work(requestId, NIL);
    expect(w.runs).toHaveLength(0);
    expect(w.watches).toBe(0);
    // Without offers: what to check and what to send, no "which event?" loop.
    const bare = await ask('Can you get us 2 tickets to a food and wine festival in Brooklyn next month?');
    const [r] = await repliesTo(bare.requestId);
    expect(r!.text).toContain('the organizer’s ticket page is the place to buy');
    expect(r!.text).toContain('Send me the ticket options');
    expect(r!.cls).not.toBe('clarification');
  });

  it('SD06: Broadway compares the offers it can see, with no trend, benchmark, tracking or backfill', async () => {
    const before = marketCalls.length;
    const { requestId } = await ask('2 tickets for Hamilton on Oct 13, up to $600 total. Is now a good time to buy?');
    const w = await work(requestId, E.hamilton);
    // The fixture world's two sources, inside Compare's budget of four.
    expect(w.searches).toBeGreaterThan(0);
    expect(w.searches).toBeLessThanOrEqual(4);
    expect(w.tracked).toBe(0);
    expect(marketCalls.length).toBe(before);
    expect(w.adviceRuns[0]!.trendRunId).toBeNull();
    expect(w.adviceRuns[0]!.benchmarkRunId).toBeNull();
    const kinds = ((w.adviceRuns[0]!.packet as { claimRecords: Array<{ kind: string }> }).claimRecords).map((c) => c.kind);
    expect(kinds).not.toContain('trend_change');
    expect(kinds).not.toContain('market_read');
    expect((w.runs[0]!.servicePolicy as { depth: string }).depth).toBe('compare');
  });

  it('SD07: "watch it and tell me when to buy" on a Guide event: a plain limit, and no watch, tracker, staff hunt or trend', async () => {
    const before = marketCalls.length;
    const { requestId } = await ask('New York Philharmonic Oct 10, 2 tickets, $250 total. Please watch it and let me know if it drops, and tell me when to buy.');
    const w = await work(requestId, E.phil);
    expect(w.watches).toBe(0);
    expect(w.tracked).toBe(0);
    expect(w.staff).toBe(0);
    expect(w.searches).toBe(0);
    expect(marketCalls.length).toBe(before);
    const notCreated = (await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'watch.not_created'), eq(t.auditLog.entityId, requestId))))[0];
    expect((notCreated!.diff as { reason: string }).reason).toBe('policy:guide_official_only');
    const all = (await repliesTo(requestId)).map((r) => r.text).join('\n');
    expect(all).toContain('nothing is being monitored');
    expect(all).not.toMatch(/prices? (?:are|have been) (?:rising|falling|dropping)|good time to buy|trend(?:ing)? (?:up|down)/i);
  });

  it('SD02: the same genre at an arena gets concert depth, at a club Guide depth', async () => {
    const arena = await ask('2 tickets for Fred again.. at MSG on Oct 15, $400 total');
    const club = await ask('2 tickets for Peggy Gou at Le Bain on Oct 13, $150 total');
    const [a] = (await work(arena.requestId, E.arenaShow)).runs;
    expect((a!.servicePolicy as { depth: string; format: string })).toMatchObject({ depth: 'core', format: 'touring' });
    expect(await versionPolicy(club.requestId)).toMatchObject({ depth: 'guide', format: 'club' });
    expect((await repliesTo(club.requestId))[0]!.text).toContain('the age rule and the latest entry time');
    expect((await work(arena.requestId, E.arenaShow)).searches).toBeGreaterThan(0);
    expect((await work(club.requestId, E.clubNight)).searches).toBe(0);
  });

  it('SD08: a Core event with no quote source covering it gets no invented inventory or listing endorsement', async () => {
    await h.db.update(t.adapterConfigs).set({ enabled: false }).where(inArray(t.adapterConfigs.sourceId, [FX.source, FX.sourceB]));
    try {
      const { requestId } = await ask('Knicks Oct 24, 2 tickets together, $300 total');
      const w = await work(requestId, FX.events.knicks);
      expect(w.searches).toBe(0);
      const packet = w.adviceRuns[0]!.packet as { verifiedOfferObservationIds: string[]; claimRecords: Array<{ kind: string }> };
      expect(packet.verifiedOfferObservationIds).toEqual([]);
      expect(packet.claimRecords.map((c) => c.kind)).not.toContain('current_offer');
      const checks = await h.db.select().from(t.sourceChecks).where(eq(t.sourceChecks.runId, w.runs[0]!.id));
      expect(checks.every((x) => x.status !== 'success')).toBe(true);
    } finally {
      await h.db.update(t.adapterConfigs).set({ enabled: true }).where(inArray(t.adapterConfigs.sourceId, [FX.source, FX.sourceB]));
    }
  });

  it('SD11: an enabled monitoring source that has never seen the event is no watch', async () => {
    const { requestId } = await ask('Long Island Testers Oct 18, 2 tickets, $300 total. Let me know if it drops.');
    expect((await work(requestId, E.testers)).watches).toBe(0);
    const [a] = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'watch.not_created'), eq(t.auditLog.entityId, requestId)));
    expect((a!.diff as { reason: string }).reason).toBe('event_not_covered');
    expect(searches.filter((x) => x === E.testers)).toHaveLength(0);
  });

  it('SD12: a watch for accessible seats never alerts on ordinary seats (F04, reproduced then fixed)', async () => {
    const { c, requestId } = await ask('Knicks Oct 24, 2 wheelchair accessible seats together, $300 total. Let me know if it drops.');
    const [w] = await h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId));
    expect(w).toBeDefined();
    expect((w!.constraints as { requireAccessible: boolean }).requireAccessible).toBe(true);
    // The failure mode: the evaluation used to compare with requireAccessible: false, which admits these seats.
    const legacy = compareOffers(OFFERS[FX.events.knicks]!, { quantity: 2, togetherRequired: true, budgetTotalCents: 30000, excludeObstructedView: true, requireAccessible: false, acceptableSections: null, eventStartAt: '2026-10-24T23:30:00Z' }, FX.events.knicks);
    expect(legacy.eligible).toHaveLength(1);
    now = new Date(w!.nextCheckAt.getTime() + 60_000);
    await c.evaluateDueWatches();
    expect(await h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.watchId, w!.id))).toHaveLength(0);
    // The same watch alerts on accessible seats at the target: the requirement is kept, not the watch broken.
    OFFERS[FX.events.knicks]!.push(offer({ id: 'knicks-accessible', eventId: FX.events.knicks, payableTotalCents: 26000, restrictions: ['accessible_seating'] }));
    now = new Date(now.getTime() + 7 * 3_600_000);
    await c.evaluateDueWatches();
    const alerts = await h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.watchId, w!.id));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payableTotalCents).toBe(26000);
    OFFERS[FX.events.knicks]!.pop();
  });

  it('SD13: a delivery deadline and an age rule survive into evaluation; unknown never counts as eligible', async () => {
    const { c, requestId } = await ask('Knicks Oct 24, 2 seats together, $300 total, my delivery deadline is 5pm. Our 15-year-old is coming. Let me know if it drops.');
    const [w] = await h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId));
    const basket = w!.constraints as { deliveryBy: string | null; unverifiable: string[]; togetherRequired: boolean };
    expect(basket.deliveryBy).not.toBeNull();
    expect(basket.unverifiable.join(' ')).toContain('15-year-old');
    expect(basket.togetherRequired).toBe(true);
    now = new Date(w!.nextCheckAt.getTime() + 60_000);
    await c.evaluateDueWatches();
    expect(await h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.watchId, w!.id))).toHaveLength(0);
  });

  it('SD14/SD15/rollout: existing Guide work is paused without a provider call; a valid cohort row keeps polling', async () => {
    const c = concierge();
    // A Guide request's tracked row and active watch, as rows written before the policy existed.
    const legacy = await ask('NY Phil Oct 10, 2 tickets', { e: env({ SERVICE_POLICY_MODE: 'off' }) });
    await h.db.delete(t.trackedEvents).where(eq(t.trackedEvents.eventId, E.phil));
    await h.db.insert(t.trackedEvents).values({ eventId: E.phil, provider: 'seatdata', reasons: ['request'], nextPollAt: FIXTURE_NOW, state: 'active', providerEventId: '555' });
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, legacy.requestId));
    const [w] = await h.db.insert(t.watches).values({ requestId: req!.id, revision: req!.currentRevision, contactId: req!.contactId, eventId: E.phil, quantity: 2, targetTotalCents: 25000, togetherRequired: true, cadenceMinutes: 60, nextCheckAt: FIXTURE_NOW, expiresAt: at('2026-10-10T00:00:00Z') }).returning();
    const [obs] = await h.db.select({ id: t.offerObservations.id }).from(t.offerObservations).limit(1);
    const [alert] = await h.db.insert(t.watchAlerts).values({ watchId: w!.id, generation: w!.generation, observationId: obs!.id, dedupeKey: `sd14:${w!.id}`, payableTotalCents: 20000, approvalState: 'pending' }).returning();
    // A cohort row on a Core event the staff named, sharing nothing with the Guide request.
    await h.db.delete(t.trackedEvents).where(eq(t.trackedEvents.eventId, FX.events.rangersRegular));
    await h.db.insert(t.trackedEvents).values({ eventId: FX.events.rangersRegular, provider: 'seatdata', reasons: ['cohort'], nextPollAt: FIXTURE_NOW, state: 'active', providerEventId: '556' });

    // Dry run first: the actions and reasons, nothing changed.
    const dry = await reconcileServiceDepth(h.db, env({ MARKET_TRACK_ENTITIES: 'new york rangers' }), { apply: false, now });
    expect(dry.actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tracked_event', id: expect.any(String), action: 'pause' }), expect.objectContaining({ kind: 'watch', id: w!.id, action: 'pause' }), expect.objectContaining({ kind: 'watch_alert', id: alert!.id, action: 'invalidate' })]));
    expect(dry.actions.find((x) => x.kind === 'tracked_event' && x.action === 'keep')).toBeDefined();
    expect((await h.db.select().from(t.watches).where(eq(t.watches.id, w!.id)))[0]!.state).toBe('active');

    const callsBefore = marketCalls.length;
    const searchesBefore = searches.filter((x) => x === E.phil).length;
    const tracker = new MarketTracker({ db: h.db, env: env({ MARKET_TRACK_ENTITIES: 'new york rangers' }), now: () => now, fetchImpl: marketFetch });
    const out = await tracker.run();
    expect(out.paused).toBe(1);
    const [row] = await h.db.select().from(t.trackedEvents).where(eq(t.trackedEvents.eventId, E.phil));
    expect(row).toMatchObject({ state: 'paused', pauseReason: 'policy:no_valid_reason' });
    // The cohort row was polled (a provider call happened for it, and only for it).
    expect(marketCalls.length).toBeGreaterThan(callsBefore);
    expect(marketCalls.slice(callsBefore).some((p) => p.includes('/555'))).toBe(false);

    await c.evaluateDueWatches();
    const [after] = await h.db.select().from(t.watches).where(eq(t.watches.id, w!.id));
    expect(after).toMatchObject({ state: 'paused', pauseReason: 'policy:guide' });
    expect((await h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.id, alert!.id)))[0]!.approvalState).toBe('invalidated');
    expect(searches.filter((x) => x === E.phil).length).toBe(searchesBefore);
  });

  it('SD16: an override that expires between drafting and dispatch blocks the stale claims', async () => {
    const { c, requestId } = await ask('Syracuse vs Duke in Syracuse on Oct 17, 2 tickets, $400 total', { e: env({ AUTO_APPROVE_WHILE_TESTING: 'false' }) });
    const w = await work(requestId, E.cuse);
    expect((w.runs[0]!.servicePolicy as { depth: string; overrideId: string })).toMatchObject({ depth: 'core', overrideId: 'ovr-cuse' });
    const [rec] = await h.db.select().from(t.recommendations).where(eq(t.recommendations.requestId, requestId));
    expect(rec!.chosenObservationIds.length).toBeGreaterThan(0);
    now = new Date(OVERRIDE_UNTIL.getTime() + 60_000);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    const approved = await c.approveRecommendation({ recommendationId: rec!.id, reviewerUserId: 'staff', expectedRevision: req!.currentRevision, draftHash: rec!.draftHash, note: null });
    expect(approved.ok).toBe(true);
    const sent = await c.dispatchSend((approved as { sendIntentId: string }).sendIntentId);
    expect(sent.outcome).toBe('blocked');
    expect(sent.reasons).toContain('policy_changed');
  });

  it('#62: a seller alert is not approved on SeatData\'s rights once the seller\'s monitoring is revoked', async () => {
    const { c, requestId } = await ask('Rangers Oct 15, 2 tickets, $500 total. Let me know if it drops.');
    const [w] = await h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId));
    now = new Date(w!.nextCheckAt.getTime() + 60_000);
    await c.evaluateDueWatches();
    const [alert] = await h.db.select().from(t.watchAlerts).where(eq(t.watchAlerts.watchId, w!.id));
    expect(alert).toMatchObject({ approvalState: 'pending', market: null });
    await h.db.update(t.adapterConfigs).set({ monitoringAllowed: false }).where(eq(t.adapterConfigs.sourceId, FX.source));
    try {
      // SeatData still covers the game (tracking, testers' allowlist), but this alert was found on the seller.
      expect(await c.approveWatchAlert({ alertId: alert!.id, reviewerUserId: 'staff' })).toEqual({ ok: false, reason: 'capability:monitoring_unavailable' });
    } finally {
      await h.db.update(t.adapterConfigs).set({ monitoringAllowed: true }).where(eq(t.adapterConfigs.sourceId, FX.source));
      await c.cancelWatch({ watchId: w!.id, actor: 'customer', reason: 'stop' });
    }
  });

  it('SD17: monitoring rights revoked after creation: no polling, a paused watch with its reason, cancel still works', async () => {
    const { c, requestId } = await ask('Rangers Oct 15, 2 tickets, $500 total. Let me know if it drops.');
    const [w] = await h.db.select().from(t.watches).where(eq(t.watches.requestId, requestId));
    expect(w).toBeDefined();
    await h.db.update(t.adapterConfigs).set({ monitoringAllowed: false }).where(eq(t.adapterConfigs.sourceId, FX.source));
    const before = searches.filter((x) => x === FX.events.rangersRegular).length;
    now = new Date(w!.nextCheckAt.getTime() + 60_000);
    await c.evaluateDueWatches();
    const [after] = await h.db.select().from(t.watches).where(eq(t.watches.id, w!.id));
    expect(after).toMatchObject({ state: 'paused', pauseReason: 'capability:monitoring_unavailable' });
    expect(searches.filter((x) => x === FX.events.rangersRegular).length).toBe(before);
    await c.cancelWatch({ watchId: w!.id, actor: 'customer', reason: 'stop' });
    expect((await h.db.select().from(t.watches).where(eq(t.watches.id, w!.id)))[0]!.state).toBe('cancelled');
    await h.db.update(t.adapterConfigs).set({ monitoringAllowed: true }).where(eq(t.adapterConfigs.sourceId, FX.source));
  });

  it('SD18: switching events in a follow-up never moves the old watch onto the new event', async () => {
    const c = concierge();
    const from = 'sd-switch@customer.example';
    const first = inbound({ text: 'Rangers Oct 15, 2 tickets, $500 total. Let me know if it drops.', from, subject: 'Switch' });
    const r = (await c.ingestInbound(first)) as { requestId: string };
    await drain(c);
    const [w1] = await h.db.select().from(t.watches).where(eq(t.watches.requestId, r.requestId));
    expect(w1).toBeDefined();
    const second = (await c.ingestInbound(inbound({ text: 'Actually make it the Knicks on Oct 24 instead, same budget.', from, subject: 'Re: Switch', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }))) as { requestId: string };
    expect(second.requestId).toBe(r.requestId);
    await drain(c);
    now = new Date(w1!.nextCheckAt.getTime() + 60_000);
    await c.evaluateDueWatches();
    const [old] = await h.db.select().from(t.watches).where(eq(t.watches.id, w1!.id));
    expect(old!.eventId).toBe(FX.events.rangersRegular);
    expect(old!.state).not.toBe('active');
  });

  it('SD19/SD27: an outside request with "tickets", a number, a budget and a date gets a short scope reply and nothing else', async () => {
    const { requestId } = await ask('Can you get 2 tickets for a pasta-making class on Oct 5? Budget $120 total.');
    const replies = await repliesTo(requestId);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.cls).not.toBe('clarification');
    expect(replies[0]!.text).toContain('I can’t book or compare classes or workshops');
    // No tier jargon, the answer first, restrained bold.
    expect(replies[0]!.text).not.toMatch(/\b(?:core|compare tier|guide tier|outside scope|service depth|tier)\b/i);
    expect((replies[0]!.html.match(/<strong>/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(replies[0]!.text.split('\n\n')[1]).toContain('I help with tickets to live events');
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.id, requestId));
    expect(req!.state).toBe('closed');
    expect((await work(requestId, NIL)).runs).toHaveLength(0);
    expect(await h.db.select().from(t.eventAlerts).where(eq(t.eventAlerts.requestId, requestId))).toHaveLength(0);
    const [ver] = await h.db.select().from(t.requestVersions).where(eq(t.requestVersions.requestId, requestId));
    expect((ver!.servicePolicy as { depth: string; category: string })).toMatchObject({ depth: 'outside', category: 'classes_workshops' });
    // A permit gets the known official route.
    const permit = await ask('I need a Half Dome permit for 2 people on Oct 12');
    expect((await repliesTo(permit.requestId))[0]!.text).toContain('Recreation.gov');
  });

  it('SD20: unsubscribe and deletion still work in an outside thread', async () => {
    const from = 'sd-controls@customer.example';
    await ask('2 tickets for a pottery class on Oct 9, $90 total', { from });
    const c = concierge();
    await c.ingestInbound(inbound({ text: 'Please unsubscribe me from all emails.', from, subject: 'Re: SD' }));
    await drain(c);
    const [req] = await h.db.select().from(t.requests).where(eq(t.requests.contactId, (await h.db.select().from(t.contacts).where(eq(t.contacts.emailLookup, from)))[0]!.id)).orderBy(t.requests.createdAt);
    const sends = await h.db.select().from(t.sendIntents).where(eq(t.sendIntents.recipient, from));
    expect(sends.some((x) => x.bodyText.includes('no marketing emails'))).toBe(true);
    expect(req).toBeDefined();
    const del = await ask('Please delete my data.', { from: 'sd-delete@customer.example' });
    expect((await repliesTo(del.requestId)).every((r) => !r.text.includes('classes or workshops'))).toBe(true);
  });

  it('SD23: a Guide question about official tickets is answered without a quantity/budget loop', async () => {
    const { requestId } = await ask('Where do I buy official tickets for the New York Philharmonic on Oct 10?');
    const replies = await repliesTo(requestId);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((r) => r.cls !== 'clarification')).toBe(true);
  });

  it('SD25: a UK event gets the US-only reply; an online-only stream the scope reply', async () => {
    const uk = await ask('2 tickets for Hamilton in London, UK on Oct 13');
    expect((await repliesTo(uk.requestId))[0]!.text).toMatch(/US/);
    const online = await ask('Is there a livestream pass for Hamilton on Oct 13?');
    expect((await repliesTo(online.requestId))[0]!.text).toContain('online-only streams');
    expect((await work(online.requestId, E.hamilton)).runs).toHaveLength(0);
  });

  it('SD26: an on-sale alert and a price watch are separate promises, kept apart on a stop', async () => {
    await h.db.update(t.events).set({ saleStatus: 'offsale', publicSaleStartAt: at('2026-10-01T14:00:00Z') }).where(inArray(t.events.id, [E.hamilton, E.phil]));
    try {
      const e = env({ EVENT_ALERTS_ENABLED: 'true' });
      const c = concierge(e);
      const first = inbound({ text: 'Let me know when Hamilton Oct 13 tickets go on sale', from: 'sd-alerts@customer.example', subject: 'Hamilton' });
      const r = (await c.ingestInbound(first)) as { requestId: string };
      await drain(c);
      const [alert] = await h.db.select().from(t.eventAlerts).where(eq(t.eventAlerts.requestId, r.requestId));
      expect(alert).toMatchObject({ kind: 'on_sale', state: 'active' });
      // "Stop monitoring the prices" ends price monitoring, not the on-sale alert, and says the alert is still on.
      await c.ingestInbound(inbound({ text: 'Stop monitoring the prices, please.', from: 'sd-alerts@customer.example', subject: 'Re: Hamilton', inReplyTo: first.rfcMessageId, references: first.rfcMessageId }));
      await drain(c);
      expect((await h.db.select().from(t.eventAlerts).where(eq(t.eventAlerts.id, alert!.id)))[0]!.state).toBe('active');
      const stopped = (await repliesTo(r.requestId)).at(-1)!.text;
      expect(stopped).toContain('There was no active price watch on this request');
      expect(stopped).toContain('event alert is still on');
      // A Guide event gets no new alert promise.
      const guide = await ask('Let me know when New York Philharmonic Oct 10 tickets go on sale', { e });
      expect(await h.db.select().from(t.eventAlerts).where(eq(t.eventAlerts.requestId, guide.requestId))).toHaveLength(0);
    } finally {
      await h.db.update(t.events).set({ saleStatus: null, publicSaleStartAt: null }).where(inArray(t.events.id, [E.hamilton, E.phil]));
    }
  });

  it('off and shadow modes leave behaviour as it was, shadow recording what enforce would block', async () => {
    const shadow = await ask('New York Philharmonic Oct 10, 2 tickets, $250 total. Let me know if it drops.', { e: env({ SERVICE_POLICY_MODE: 'shadow' }) });
    expect((await work(shadow.requestId, E.phil)).watches).toBe(1);
    const would = await h.db.select().from(t.auditLog).where(and(eq(t.auditLog.action, 'service_policy.would_block'), eq(t.auditLog.entityId, shadow.requestId)));
    expect(would.map((a) => (a.diff as { operation: string }).operation)).toEqual(expect.arrayContaining(['price_watch']));
    const off = await ask('Can you get 2 tickets for a pasta-making class on Oct 5? Budget $120 total.', { e: env({ SERVICE_POLICY_MODE: 'off' }) });
    expect((await repliesTo(off.requestId)).some((r) => r.text.includes('classes or workshops'))).toBe(false);
    const [v] = await h.db.select().from(t.requestVersions).where(inArray(t.requestVersions.requestId, [off.requestId]));
    expect(v?.servicePolicy ?? null).toBeNull();
  });
});
