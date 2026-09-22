import { sql } from 'drizzle-orm';
import type { Db } from './index';
import * as t from './schema';
import { loadRegistry } from '@/lib/sources/registry';
import { validateRouting, ROUTING_VERSION } from '@/lib/sources/routing';
import { ensureDefaultSwitches } from '@/lib/email/send-gate';
import { FX, FIXTURE_HISTORICAL_EVENTS, FIXTURE_NOW, RANGERS_PRESEASON_START } from '@/lib/fixtures';
import { basketKeyFor } from '@/lib/intake/pipeline';

/** Registry import: all 135 entries as not_integrated. Historical evidence is never overwritten on re-seed. */
export async function seedRegistry(db: Db): Promise<number> {
  validateRouting();
  const reg = loadRegistry();
  for (const s of reg.sources) {
    await db
      .insert(t.sourceRegistry)
      .values({ id: s.id, name: s.name, url: s.url, groupName: s.group, sourceType: s.source_type, categories: s.categories, routingTier: s.routing_tier, routingNote: s.routing_note, evidenceUrl: s.evidence_url, evidenceLevel: s.evidence_level, researchDate: s.research_date, integrationStatus: s.integration_status, accessRights: s.access_rights, usEventOnly: s.us_event_only, vettingStatus: s.recommendation_vetting_status, registryVersion: `${reg.version}/routing-${ROUTING_VERSION}` })
      .onConflictDoNothing();
  }
  await ensureDefaultSwitches(db);
  return reg.sources.length;
}

/** Synthetic fixture world. Only for APP_MODE=fixture / tests. */
export async function seedFixtures(db: Db): Promise<void> {
  await db.insert(t.venues).values([
    { id: FX.venues.msg, name: 'Madison Square Garden', aliases: ['MSG', 'The Garden'], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v2024' },
    { id: FX.venues.barclays, name: 'Barclays Center', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v2024' },
    { id: FX.venues.yankee, name: 'Yankee Stadium', aliases: [], city: 'New York', state: 'NY', country: 'US', timezone: 'America/New_York', layoutVersion: 'v2024' },
    { id: FX.venues.scotiabank, name: 'Scotiabank Arena', aliases: [], city: 'Toronto', state: 'ON', country: 'CA', timezone: 'America/Toronto', layoutVersion: 'v2024' },
  ]).onConflictDoNothing();
  await db.insert(t.entities).values([
    { id: FX.entities.rangers, kind: 'team', name: 'New York Rangers', slug: 'new-york-rangers', aliases: ['Rangers', 'NY Rangers', 'NYR'], league: 'NHL', homeVenueId: FX.venues.msg },
    { id: FX.entities.islanders, kind: 'team', name: 'New York Islanders', slug: 'new-york-islanders', aliases: ['Islanders'], league: 'NHL', homeVenueId: null },
    { id: FX.entities.knicks, kind: 'team', name: 'New York Knicks', slug: 'new-york-knicks', aliases: ['Knicks'], league: 'NBA', homeVenueId: FX.venues.msg },
    { id: FX.entities.yankees, kind: 'team', name: 'New York Yankees', slug: 'new-york-yankees', aliases: ['Yankees'], league: 'MLB', homeVenueId: FX.venues.yankee },
    { id: FX.entities.duaLipa, kind: 'performer', name: 'Dua Lipa', slug: 'dua-lipa', aliases: [], league: null, homeVenueId: null },
    { id: FX.entities.leafs, kind: 'team', name: 'Toronto Maple Leafs', slug: 'toronto-maple-leafs', aliases: ['Maple Leafs', 'Leafs'], league: 'NHL', homeVenueId: FX.venues.scotiabank },
  ]).onConflictDoNothing();
  await db.insert(t.events).values([
    { id: FX.events.rangersPreseason, name: 'New York Rangers vs. New York Islanders (preseason)', category: 'nhl', subtype: 'preseason', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, opponentEntityId: FX.entities.islanders, isHome: true, localStartAt: RANGERS_PRESEASON_START, status: 'scheduled', verifiedSourceId: 'fixture', isFixture: true },
    { id: FX.events.rangersRegular, name: 'New York Rangers vs. Fixture Opponent (regular season)', category: 'nhl', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, isHome: true, localStartAt: new Date('2026-10-15T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'fixture', isFixture: true },
    { id: FX.events.knicks, name: 'New York Knicks vs. Fixture Opponent', category: 'nba', subtype: 'regular_season', venueId: FX.venues.msg, primaryEntityId: FX.entities.knicks, isHome: true, localStartAt: new Date('2026-10-24T23:30:00Z'), status: 'scheduled', verifiedSourceId: 'fixture', isFixture: true },
    { id: FX.events.yankees, name: 'New York Yankees vs. Fixture Opponent', category: 'mlb', subtype: 'regular_season', venueId: FX.venues.yankee, primaryEntityId: FX.entities.yankees, isHome: true, localStartAt: new Date('2026-09-30T23:05:00Z'), status: 'scheduled', verifiedSourceId: 'fixture', isFixture: true },
    { id: FX.events.leafsToronto, name: 'Toronto Maple Leafs vs. Fixture Opponent', category: 'nhl', subtype: 'regular_season', venueId: FX.venues.scotiabank, primaryEntityId: FX.entities.leafs, isHome: true, localStartAt: new Date('2026-10-10T23:00:00Z'), status: 'scheduled', verifiedSourceId: 'fixture', isFixture: true },
    ...FIXTURE_HISTORICAL_EVENTS.map((h): typeof t.events.$inferInsert => ({ id: h.id, name: h.name, category: 'nhl', subtype: 'preseason', venueId: FX.venues.msg, primaryEntityId: FX.entities.rangers, isHome: true, localStartAt: h.localStartAt, status: 'completed', verifiedSourceId: 'fixture', isFixture: true })),
  ]).onConflictDoNothing();

  // Fixture source registry rows (clearly marked) + enabled fixture adapters; every real source stays not_integrated.
  await db.insert(t.sourceRegistry).values([
    { id: FX.source, name: 'FIXTURE SOURCE (synthetic)', url: 'https://example.invalid/fixture', groupName: 'Fixture', sourceType: 'Fixture', categories: ['fixture'], routingTier: 'conditional', routingNote: 'Synthetic offers for local demos only.', evidenceUrl: 'https://example.invalid/fixture', evidenceLevel: 'FIXTURE — not a real source', researchDate: '2026-09-22', integrationStatus: 'fixture', accessRights: 'fixture', usEventOnly: true, vettingStatus: 'fixture', registryVersion: 'fixture' },
    { id: FX.sourceB, name: 'FIXTURE SOURCE B (synthetic)', url: 'https://example.invalid/fixture-b', groupName: 'Fixture', sourceType: 'Fixture', categories: ['fixture'], routingTier: 'conditional', routingNote: 'Second synthetic source for duplicate/coverage scenarios.', evidenceUrl: 'https://example.invalid/fixture-b', evidenceLevel: 'FIXTURE — not a real source', researchDate: '2026-09-22', integrationStatus: 'fixture', accessRights: 'fixture', usEventOnly: true, vettingStatus: 'fixture', registryVersion: 'fixture' },
  ]).onConflictDoNothing();
  await db.insert(t.adapterConfigs).values([
    { sourceId: FX.source, implementation: 'fixture', enabled: true, capabilities: ['event_lookup', 'quote_search', 'quote_revalidation', 'monitoring'], accessApprovalEvidence: 'FIXTURE — synthetic data, no rights needed', monitoringAllowed: true, retentionDays: 90, reviewedBy: 'seed' },
    { sourceId: FX.sourceB, implementation: 'fixture', enabled: true, capabilities: ['quote_search', 'quote_revalidation'], accessApprovalEvidence: 'FIXTURE — synthetic data, no rights needed', monitoringAllowed: false, retentionDays: 90, reviewedBy: 'seed' },
  ]).onConflictDoNothing();

  // Historical dataset (fixture) + one 5-seat snapshot per past event at ~4 days lead, plus a few extra snapshots per event.
  await db.insert(t.marketDatasets).values({ id: FX.dataset, provider: 'FIXTURE', licenseReference: 'none — synthetic', approvedUses: ['benchmark', 'customer_display', 'derived_aggregates'], coverageNote: '12 synthetic Rangers preseason games', status: 'approved', isFixture: true, approvedBy: 'seed' }).onConflictDoNothing();
  const basket5 = basketKeyFor(FX.events.rangersPreseason, 5, 'upper');
  const snaps: Array<typeof t.marketSnapshots.$inferInsert> = [];
  for (const h of FIXTURE_HISTORICAL_EVENTS) {
    // One snapshot per lead bucket so the demo works whatever today's date is (bucket-matched representative).
    for (const [lead, delta] of [[4 * 24 * 60 + 15, 0], [5 * 24 * 60, 4000], [6 * 24 * 60, 9000], [11 * 24 * 60, 0], [20 * 24 * 60, 2500], [40 * 24 * 60, 6000], [2 * 24 * 60, -1500], [18 * 60, -3000]] as const) {
      snaps.push({ datasetId: FX.dataset, eventId: h.id, basketKey: basketKeyFor(h.id, 5, 'upper'), quantity: 5, seatZone: 'upper', observedAt: new Date(h.localStartAt.getTime() - lead * 60_000), leadTimeMinutes: lead, cheapestEligibleTotalCents: h.fiveSeatBestCents + delta, eligibleOptionCount: 4, sourceIds: [FX.source, FX.sourceB], feeBasis: 'verified_total', coverageComplete: true, qualityFlags: [], methodVersion: 'fixture', isFixture: true });
    }
    // A50 guard data: many near-duplicate snapshots of one event must still count once.
    for (let k = 0; k < 20; k++) snaps.push({ datasetId: FX.dataset, eventId: h.id, basketKey: basketKeyFor(h.id, 5, 'upper'), quantity: 5, seatZone: 'upper', observedAt: new Date(h.localStartAt.getTime() - (4 * 24 * 60 + 30 + k) * 60_000), leadTimeMinutes: 4 * 24 * 60 + 30 + k, cheapestEligibleTotalCents: h.fiveSeatBestCents + 100 * k, eligibleOptionCount: 4, sourceIds: [FX.source, FX.sourceB], feeBasis: 'verified_total', coverageComplete: true, qualityFlags: [], methodVersion: 'fixture', isFixture: true });
  }
  // Current-event trend: four observations over 24h, five together upper, falling $475 → $425.
  const trend: Array<[number, number]> = [[24, 47500], [12, 46000], [6, 44000], [0, 42500]];
  for (const [hAgo, cents] of trend) {
    snaps.push({ datasetId: null, eventId: FX.events.rangersPreseason, basketKey: basket5, quantity: 5, seatZone: 'upper', observedAt: new Date(FIXTURE_NOW.getTime() - hAgo * 3_600_000), leadTimeMinutes: Math.round((RANGERS_PRESEASON_START.getTime() - (FIXTURE_NOW.getTime() - hAgo * 3_600_000)) / 60_000), cheapestEligibleTotalCents: cents, eligibleOptionCount: 3, sourceIds: [FX.source, FX.sourceB], feeBasis: 'verified_total', coverageComplete: true, qualityFlags: [`cheapest_source:${FX.source}`], methodVersion: 'fixture', isFixture: true });
  }
  await db.insert(t.marketSnapshots).values(snaps);
  await db.insert(t.venueSeatZones).values([
    ...['208', '212', '218', '224', '227', '419'].map((s) => ({ venueId: FX.venues.msg, layoutVersion: 'v2024', section: s, zone: 'upper', evidence: 'fixture', reviewedBy: 'seed' })),
    { venueId: FX.venues.msg, layoutVersion: 'v2024', section: '110', zone: 'lower', evidence: 'fixture', reviewedBy: 'seed' },
  ]).onConflictDoNothing();
}

export async function countRows(db: Db, table: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`));
  const rows = (Array.isArray(r) ? r : (r as unknown as { rows: Array<{ n: number }> }).rows) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}
