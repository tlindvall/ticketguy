import { and, eq, gte, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import * as t from '@/lib/db/schema';
import type { DiscoveredAttraction, DiscoveredEvent, DiscoveredVenue, DiscoveryQuery, TicketmasterDiscoveryAdapter } from '@/lib/sources/adapters';
import type { SourceStatus } from '@/lib/domain/types';
import { localToInstant } from '@/lib/domain/dates';

/**
 * Turns Ticketmaster Discovery results into the canonical catalog — venues, performers/teams, events and the
 * provider mapping for each — so event resolution has something to resolve against.
 *
 * Two rules the rest of the system relies on:
 *  - Idempotent. Every row is keyed on a provider id (venues and entities through external_ids, events through
 *    event_source_mappings), so the same event synced twice updates one row and never creates a second.
 *  - Nothing here is an offer. Discovery is event-level; its price ranges are dropped before this module ever
 *    sees them (A12). The catalog says what exists and when, never what it costs.
 */

export const DISCOVERY_SOURCE_ID = 'ticketmaster';

/** Do not ask the provider the same question again inside this window; the answer will not have changed. */
export const SYNC_FRESHNESS_HOURS = 6;
/** Provider default quota is 5,000/day; the enforced ceiling leaves headroom for retries and staff use. */
export const DEFAULT_DAILY_CALL_LIMIT = 4000;

export type SyncTrigger = 'interpret' | 'prewarm' | 'manual';

export type SyncOutcome = {
  status: SourceStatus | 'skipped_fresh' | 'skipped_budget';
  eventsSeen: number;
  eventsUpserted: number;
  /** Canonical entity ids that matched the query keyword, for the caller to resolve against. */
  entityIds: string[];
};

export function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Category the routing matrix understands, from the provider's classification. The routing keys are the
 * contract (src/lib/sources/routing.ts); anything unmapped falls to the broadest key in its segment so a
 * request still gets a source plan rather than none.
 */
export function categoryFor(e: { segment: string | null; genre: string | null; subGenre: string | null; name: string }): string {
  const seg = (e.segment ?? '').toLowerCase();
  const genre = (e.genre ?? '').toLowerCase();
  const sub = (e.subGenre ?? '').toLowerCase();
  const name = e.name.toLowerCase();
  if (seg === 'sports') {
    if (sub.includes('nhl') || genre === 'hockey') return sub.includes('nhl') ? 'nhl' : 'minor_league';
    if (sub.includes('wnba')) return 'wnba';
    if (sub.includes('nba') || (genre === 'basketball' && !sub.includes('college') && !sub.includes('ncaa'))) return 'nba';
    if (sub.includes('mlb') || genre === 'baseball') return sub.includes('minor') ? 'minor_league' : 'mlb';
    if (sub.includes('nfl') || (genre === 'football' && !sub.includes('college') && !sub.includes('ncaa'))) return 'nfl';
    if (genre === 'soccer' || sub.includes('mls') || sub.includes('nwsl')) return 'soccer';
    if (sub.includes('college') || sub.includes('ncaa')) return /bowl|championship|final four|tournament/.test(name) ? 'ncaa_championship' : 'ncaa_regular';
    if (['boxing', 'mixed martial arts', 'wrestling'].includes(genre) || /\b(ufc|wwe|aew)\b/.test(name)) return 'combat';
    if (['motorsports/racing', 'motorsports', 'racing'].includes(genre) || /nascar|indycar|nhra|grand prix/.test(name)) return 'motorsport';
    if (['tennis', 'golf'].includes(genre)) return 'tennis_golf';
    return 'emerging_sports';
  }
  if (seg === 'music') {
    if (genre === 'dance/electronic' || genre === 'electronic') return 'electronic_nightlife';
    if (/festival|fest\b/.test(name)) return 'festival';
    return 'concert';
  }
  if (seg === 'arts & theatre' || seg === 'arts and theatre') {
    if (genre === 'theatre' && /broadway/.test(sub + ' ' + name)) return 'broadway';
    if (genre === 'theatre') return 'touring_theater';
    if (['classical', 'opera', 'ballet', 'dance'].includes(genre)) return 'classical';
    if (genre === 'comedy') return 'comedy';
    if (/circus|family|kids/.test(genre + ' ' + sub)) return 'family';
    return 'touring_theater';
  }
  if (seg === 'family') return 'family';
  if (seg === 'film') return 'cinema';
  return 'concert';
}

/**
 * Not every Discovery event is an admission you can compare. Parking, packages and suites are real events
 * on the provider's side and useless as a match for "5 tickets to the Rangers", so they are kept (a customer
 * may ask for them) but tagged, and resolution skips the tagged ones.
 */
export function subtypeFor(e: { name: string; timeTba: boolean }): string | null {
  const n = e.name.toLowerCase();
  if (/\bparking\b/.test(n)) return 'parking';
  if (/\b(vip|package|packages|suite|suites|hospitality|premium experience|fan pack|meet\s*(&|and)\s*greet)\b/.test(n)) return 'package';
  if (/\bpreseason\b/.test(n)) return 'preseason';
  if (/\b(playoff|playoffs|postseason)\b/.test(n)) return 'playoffs';
  if (e.timeTba) return 'time_tba';
  return null;
}

/** Subtypes that are never what a customer means by "tickets to the game". */
export const NON_ADMISSION_SUBTYPES: readonly string[] = ['parking', 'package'];

export function statusFor(code: string): string {
  if (code === 'cancelled' || code === 'canceled') return 'cancelled';
  if (code === 'postponed') return 'postponed';
  return 'scheduled';
}

/**
 * Sports names come as "Home vs. Away" or "Away at Home". The primary entity is the one the customer asked
 * about; home/away is only asserted when the name says so.
 */
export function parseMatchup(name: string): { first: string; second: string; homeIs: 'first' | 'second' } | null {
  const vs = /^(.+?)\s+(?:vs\.?|v\.?)\s+(.+)$/i.exec(name);
  if (vs) return { first: vs[1]!.trim(), second: vs[2]!.trim(), homeIs: 'first' };
  const at = /^(.+?)\s+at\s+(.+)$/i.exec(name);
  if (at) return { first: at[1]!.trim(), second: at[2]!.trim(), homeIs: 'second' };
  return null;
}

/** Team nickname alias ("Rangers" for "New York Rangers") so the customer's word finds the row. */
export function teamAliases(name: string): string[] {
  const words = name.trim().split(/\s+/);
  const last = words[words.length - 1] ?? '';
  if (words.length >= 2 && last.length >= 4 && /^[A-Za-z]+$/.test(last)) return [last];
  return [];
}

function entityKindFor(segment: string | null): string {
  const s = (segment ?? '').toLowerCase();
  if (s === 'sports') return 'team';
  if (s === 'arts & theatre' || s === 'arts and theatre') return 'production';
  return 'performer';
}

function leagueFor(a: DiscoveredAttraction): string | null {
  if ((a.segment ?? '').toLowerCase() !== 'sports') return null;
  const sub = a.subGenre ?? '';
  const known = ['NHL', 'NBA', 'WNBA', 'MLB', 'NFL', 'MLS', 'NWSL'];
  const hit = known.find((k) => sub.toUpperCase().includes(k));
  return hit ?? a.genre ?? null;
}

async function upsertVenue(db: DbOrTx, v: DiscoveredVenue): Promise<string | null> {
  if (!v.timezone) return null; // a venue with no timezone cannot host a date-resolvable event
  const byExternal = await db.select({ id: t.venues.id }).from(t.venues).where(sql`${t.venues.externalIds} ->> ${DISCOVERY_SOURCE_ID} = ${v.providerId}`);
  if (byExternal[0]) {
    await db.update(t.venues).set({ timezone: v.timezone, city: v.city, state: v.stateCode }).where(eq(t.venues.id, byExternal[0].id));
    return byExternal[0].id;
  }
  const byName = await db.select({ id: t.venues.id, externalIds: t.venues.externalIds }).from(t.venues).where(and(sql`lower(${t.venues.name}) = ${v.name.toLowerCase()}`, v.city ? sql`lower(coalesce(${t.venues.city}, '')) = ${v.city.toLowerCase()}` : sql`true`));
  if (byName[0]) {
    await db.update(t.venues).set({ externalIds: { ...byName[0].externalIds, [DISCOVERY_SOURCE_ID]: v.providerId }, timezone: v.timezone }).where(eq(t.venues.id, byName[0].id));
    return byName[0].id;
  }
  const [row] = await db.insert(t.venues).values({ name: v.name, aliases: [], city: v.city, state: v.stateCode, country: v.countryCode ?? 'US', timezone: v.timezone, externalIds: { [DISCOVERY_SOURCE_ID]: v.providerId } }).returning({ id: t.venues.id });
  return row!.id;
}

async function upsertEntity(db: DbOrTx, a: DiscoveredAttraction): Promise<string> {
  const kind = entityKindFor(a.segment);
  const aliases = kind === 'team' ? teamAliases(a.name) : [];
  const league = leagueFor(a);
  const byExternal = await db.select({ id: t.entities.id, aliases: t.entities.aliases }).from(t.entities).where(sql`${t.entities.externalIds} ->> ${DISCOVERY_SOURCE_ID} = ${a.providerId}`);
  if (byExternal[0]) {
    await db.update(t.entities).set({ name: a.name, aliases: [...new Set([...byExternal[0].aliases, ...aliases])], league }).where(eq(t.entities.id, byExternal[0].id));
    return byExternal[0].id;
  }
  const slug = slugify(a.name);
  const bySlug = await db.select({ id: t.entities.id, aliases: t.entities.aliases, externalIds: t.entities.externalIds }).from(t.entities).where(eq(t.entities.slug, slug));
  if (bySlug[0]) {
    await db.update(t.entities).set({ externalIds: { ...bySlug[0].externalIds, [DISCOVERY_SOURCE_ID]: a.providerId }, aliases: [...new Set([...bySlug[0].aliases, ...aliases])], league: league ?? undefined }).where(eq(t.entities.id, bySlug[0].id));
    return bySlug[0].id;
  }
  const [row] = await db.insert(t.entities).values({ kind, name: a.name, slug, aliases, league, homeVenueId: null, externalIds: { [DISCOVERY_SOURCE_ID]: a.providerId } }).returning({ id: t.entities.id });
  return row!.id;
}

/** Writes one discovered event into the catalog. Returns the canonical event id, or null when it cannot be placed. */
export async function upsertDiscoveredEvent(db: DbOrTx, e: DiscoveredEvent, keyword: string): Promise<{ eventId: string; entityIds: string[] } | null> {
  if (!e.venue) return null;
  if (e.venue.countryCode && e.venue.countryCode !== 'US') return null; // launch boundary; the query already asks for US only
  const venueId = await upsertVenue(db, e.venue);
  if (!venueId) return null;
  const tz = e.timezone ?? e.venue.timezone;
  if (!tz) return null;

  let startAt: Date;
  if (e.startAt) startAt = new Date(e.startAt);
  else if (e.localDate) startAt = localToInstant(e.localDate, e.localTime ?? '12:00', tz);
  else return null;
  if (Number.isNaN(startAt.getTime())) return null;

  const entityIds: string[] = [];
  for (const a of e.attractions) entityIds.push(await upsertEntity(db, a));

  // Which attraction is the one the customer named; for sports, which side is home.
  const kw = normalizeKeyword(keyword);
  const matchIdx = e.attractions.findIndex((a) => normalizeKeyword(a.name).includes(kw) || teamAliases(a.name).some((al) => normalizeKeyword(al) === kw));
  const primaryIdx = matchIdx >= 0 ? matchIdx : 0;
  const primaryEntityId = entityIds[primaryIdx] ?? null;
  const opponentEntityId = entityIds.length === 2 ? entityIds[primaryIdx === 0 ? 1 : 0] ?? null : null;
  let isHome: boolean | null = null;
  const m = parseMatchup(e.name);
  if (m && entityIds.length === 2 && primaryEntityId) {
    const primaryName = normalizeKeyword(e.attractions[primaryIdx]!.name);
    const homeName = normalizeKeyword(m.homeIs === 'first' ? m.first : m.second);
    isHome = homeName.includes(primaryName) || primaryName.includes(homeName);
  }

  const category = categoryFor(e);
  const subtype = subtypeFor(e);
  const status = statusFor(e.statusCode);

  const existing = await db.select({ eventId: t.eventSourceMappings.eventId }).from(t.eventSourceMappings).where(and(eq(t.eventSourceMappings.sourceId, DISCOVERY_SOURCE_ID), eq(t.eventSourceMappings.sourceEventId, e.providerEventId)));
  if (existing[0]) {
    await db.update(t.events).set({ name: e.name, category, subtype, venueId, primaryEntityId, opponentEntityId, isHome, localStartAt: startAt, status }).where(eq(t.events.id, existing[0].eventId));
    await db.update(t.eventSourceMappings).set({ authoritativeUrl: e.url, verifiedAt: new Date() }).where(and(eq(t.eventSourceMappings.sourceId, DISCOVERY_SOURCE_ID), eq(t.eventSourceMappings.sourceEventId, e.providerEventId)));
    return { eventId: existing[0].eventId, entityIds };
  }
  const [row] = await db.insert(t.events).values({ name: e.name, category, subtype, venueId, primaryEntityId, opponentEntityId, isHome, localStartAt: startAt, status, verifiedSourceId: DISCOVERY_SOURCE_ID, isFixture: false }).returning({ id: t.events.id });
  await db.insert(t.eventSourceMappings).values({ eventId: row!.id, sourceId: DISCOVERY_SOURCE_ID, sourceEventId: e.providerEventId, authoritativeUrl: e.url, role: 'discovery', confidence: 'provider_id', verifiedAt: new Date() }).onConflictDoNothing();
  return { eventId: row!.id, entityIds };
}

export async function callsToday(db: DbOrTx, now = new Date()): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(t.catalogSyncs).where(and(eq(t.catalogSyncs.sourceId, DISCOVERY_SOURCE_ID), gte(t.catalogSyncs.syncedAt, dayStart), sql`${t.catalogSyncs.status} not in ('skipped_fresh', 'skipped_budget')`));
  return r?.n ?? 0;
}

async function recentlySynced(db: DbOrTx, keyword: string, city: string | null, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - SYNC_FRESHNESS_HOURS * 3_600_000);
  const rows = await db
    .select({ id: t.catalogSyncs.id })
    .from(t.catalogSyncs)
    .where(and(eq(t.catalogSyncs.sourceId, DISCOVERY_SOURCE_ID), eq(t.catalogSyncs.keywordNormalized, keyword), city ? sql`lower(coalesce(${t.catalogSyncs.city}, '')) = ${city.toLowerCase()}` : sql`true`, gte(t.catalogSyncs.syncedAt, since), eq(t.catalogSyncs.status, 'success')))
    .limit(1);
  return rows.length > 0;
}

/**
 * One bounded discovery call, written into the catalog. Never throws for provider trouble: a timeout or a
 * rate limit is recorded and reported, and the caller carries on with whatever the catalog already holds.
 */
export async function syncFromDiscovery(
  db: DbOrTx,
  adapter: TicketmasterDiscoveryAdapter,
  q: DiscoveryQuery & { trigger: SyncTrigger; dailyCallLimit?: number | null; now?: Date; force?: boolean },
): Promise<SyncOutcome> {
  const now = q.now ?? new Date();
  const keyword = normalizeKeyword(q.keyword);
  const city = q.city ?? null;
  const record = async (status: SyncOutcome['status'], eventCount: number) => {
    await db.insert(t.catalogSyncs).values({ sourceId: DISCOVERY_SOURCE_ID, keywordNormalized: keyword, city, windowFrom: q.startDateTime ?? null, windowTo: q.endDateTime ?? null, status, eventCount, trigger: q.trigger, syncedAt: now });
  };

  if (!q.force && (await recentlySynced(db, keyword, city, now))) return { status: 'skipped_fresh', eventsSeen: 0, eventsUpserted: 0, entityIds: [] };
  const limit = q.dailyCallLimit ?? DEFAULT_DAILY_CALL_LIMIT;
  if ((await callsToday(db, now)) >= limit) {
    await record('skipped_budget', 0);
    return { status: 'skipped_budget', eventsSeen: 0, eventsUpserted: 0, entityIds: [] };
  }

  const res = await adapter.discoverEvents({ keyword: q.keyword, city, stateCode: q.stateCode ?? null, startDateTime: q.startDateTime ?? null, endDateTime: q.endDateTime ?? null, size: q.size });
  if (res.status !== 'success') {
    await record(res.status, 0);
    return { status: res.status, eventsSeen: 0, eventsUpserted: 0, entityIds: [] };
  }

  const entityIds = new Set<string>();
  let upserted = 0;
  for (const e of res.events) {
    const r = await upsertDiscoveredEvent(db, e, q.keyword);
    if (!r) continue;
    upserted += 1;
    for (const id of r.entityIds) entityIds.add(id);
  }
  await record('success', upserted);
  return { status: 'success', eventsSeen: res.events.length, eventsUpserted: upserted, entityIds: [...entityIds] };
}
