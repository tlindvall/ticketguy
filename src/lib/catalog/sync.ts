import { and, eq, gte, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import * as t from '@/lib/db/schema';
import type { DiscoveredAttraction, DiscoveredEvent, DiscoveredVenue, DiscoveryQuery, TicketmasterDiscoveryAdapter } from '@/lib/sources/adapters';
import type { SourceStatus } from '@/lib/domain/types';
import { localTimeInstants } from '@/lib/domain/dates';
import { inMarket, teamHomeMarket } from '@/lib/domain/markets';

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

export type SyncTrigger = 'interpret' | 'prewarm' | 'manual' | 'alert';

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
 * contract (src/lib/sources/routing.ts). Inside a known segment, an unmapped genre falls to the broadest key in
 * it. Outside the known segments the category is `unknown`, never `concert`: an unrecognised product must not
 * inherit concert depth (service-depth F01). The genre names the music, not the format: electronic music keeps
 * its routing key, and whether it's an arena show or a club night is decided from the venue (eventFormat).
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
    // "Fest" alone isn't a festival ("Riot Fest" is, "Metalfest Night at the Bowery" may not be); the word is.
    if (/\bfestival\b/.test(name) || genre === 'festival') return 'festival';
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
  if (seg === 'miscellaneous') {
    if (/food|drink|wine|beer/.test(genre + ' ' + sub)) return 'food_drink';
    if (/fair|festival|community|civic/.test(genre + ' ' + sub)) return 'fairs_community';
    if (/expo|hobby|convention/.test(genre + ' ' + sub)) return 'conventions';
  }
  return 'unknown';
}

/** How the category was reached, kept with the event so staff can see why it got its depth. */
export function classificationFor(e: { segment: string | null; genre: string | null; subGenre: string | null; name: string }): { segment: string | null; genre: string | null; subGenre: string | null; category: string; reason: string } {
  const category = categoryFor(e);
  const known = ['sports', 'music', 'arts & theatre', 'arts and theatre', 'family', 'film'].includes((e.segment ?? '').toLowerCase());
  return { segment: e.segment, genre: e.genre, subGenre: e.subGenre, category, reason: category === 'unknown' ? 'unmapped_segment' : known ? 'provider_segment' : 'provider_genre' };
}

/**
 * Not every Discovery event is an admission you can compare. Parking, packages and suites are real events
 * on the provider's side and useless as a match for "5 tickets to the Rangers", so they are kept (a customer
 * may ask for them) but tagged, and resolution skips the tagged ones.
 */
export function subtypeFor(e: { name: string; timeTba: boolean }): string | null {
  const n = e.name.toLowerCase();
  if (/\bparking\b/.test(n)) return 'parking';
  // "Premium Seating", "Club Seats" and pass variants are the same game sold as an add-on, never the game itself (live Oct 1: a
  // Rangers link resolved to the Premium Seating listing and its time).
  if (/\b(vip|package|packages|suite|suites|hospitality|premium (?:experience|seating|seats?|access)|club (?:seats?|seating|access|level)|pinstripe pass|fan pack|meet\s*(&|and)\s*greet)\b/.test(n)) return 'package';
  // NFL listings sell the right to buy (seat licences), season plans and tailgates alongside the game itself.
  if (/\b(psls?|personal seat licen[cs]es?|season tickets?|season (?:ticket )?plans?|tailgates?|tailgating)\b/.test(n)) return 'package';
  // A bundle of dated shows sold as one ("2-Day Ticket (10/8/26 & 10/10/26) Cannot Split By Day") is not a performance and
  // carries no show time of its own (live Oct 2: it was offered as a noon Metallica show). A festival's own day or
  // weekend pass is its admission, so only a bundle that names its shows' dates, or says it can't be split, is set aside.
  if (/\bcannot split\b|\bcan'?t (?:be )?split\b/.test(n) || (/\b(?:[2-9]|two|three|four|multi)[- ]day (?:ticket|pass|package|bundle)s?\b/.test(n) && /\(\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*(?:&|and|,)/.test(n))) return 'package';
  if (/\bpreseason\b/.test(n)) return 'preseason';
  if (/\b(playoff|playoffs|postseason)\b/.test(n)) return 'playoffs';
  if (e.timeTba) return 'time_tba';
  return null;
}

/**
 * Events filed under a team that are not one of its games: alumni games, fan fests, open practices, watch
 * parties. Asked for "Rangers tickets next week", a November alumni night is not an answer, so resolution
 * leaves these out unless the customer's own words name them. Deliberately narrow — "tour" or "experience"
 * would also catch concerts and premium seats — and applied to teams only.
 */
export const NON_GAME_PATTERN = /\b(alumni|fan\s?fest|fanfest|watch party|viewing party|open practice|practice|skills (?:competition|challenge)|clinic|camp|draft party|gala|luncheon|autograph)\b/i;

/**
 * The genre and sub-genre, lowercased ("rock / indie rock"), from the headliner's classification or, when
 * that is blank, the event's. The headliner comes first because venues file their whole calendar under one
 * genre: a hip-hop night at a bowling-alley venue arrives as "Rock". "Undefined" and "Other" mean none.
 */
export function genreFor(e: Pick<DiscoveredEvent, 'genre' | 'subGenre' | 'attractions'>): string | null {
  const real = (v: string | null | undefined) => (v && !/^(undefined|other)$/i.test(v.trim()) ? v.trim().toLowerCase() : null);
  const a = e.attractions[0];
  const main = real(a?.genre) ?? real(e.genre);
  const sub = real(a?.genre) ? real(a?.subGenre) : real(e.subGenre);
  const parts = [main, sub].filter((x): x is string => !!x);
  return parts.length ? [...new Set(parts)].join(' / ') : null;
}

export function isNonGameName(name: string): boolean {
  return NON_GAME_PATTERN.test(name);
}

/** Subtypes that are never what a customer means by "tickets to the game". */
export const NON_ADMISSION_SUBTYPES: readonly string[] = ['parking', 'package'];

/**
 * Whether an event row is an add-on rather than an admission: its stored subtype, or its name read again, so a row
 * synced before a pattern existed (a pass stored as time_tba) is set aside without waiting for its next sync.
 */
export function isNonAdmission(e: { name: string; subtype: string | null }): boolean {
  if (e.subtype && NON_ADMISSION_SUBTYPES.includes(e.subtype)) return true;
  const now = subtypeFor({ name: e.name, timeTba: false });
  return !!now && NON_ADMISSION_SUBTYPES.includes(now);
}

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
  const coords = v.latitude != null && v.longitude != null ? { latitude: v.latitude, longitude: v.longitude } : {};
  const byExternal = await db.select({ id: t.venues.id }).from(t.venues).where(sql`${t.venues.externalIds} ->> ${DISCOVERY_SOURCE_ID} = ${v.providerId}`);
  if (byExternal[0]) {
    await db.update(t.venues).set({ timezone: v.timezone, city: v.city, state: v.stateCode, ...coords }).where(eq(t.venues.id, byExternal[0].id));
    return byExternal[0].id;
  }
  const byName = await db.select({ id: t.venues.id, externalIds: t.venues.externalIds }).from(t.venues).where(and(sql`lower(${t.venues.name}) = ${v.name.toLowerCase()}`, v.city ? sql`lower(coalesce(${t.venues.city}, '')) = ${v.city.toLowerCase()}` : sql`true`));
  if (byName[0]) {
    await db.update(t.venues).set({ externalIds: { ...byName[0].externalIds, [DISCOVERY_SOURCE_ID]: v.providerId }, timezone: v.timezone, ...coords }).where(eq(t.venues.id, byName[0].id));
    return byName[0].id;
  }
  const [row] = await db.insert(t.venues).values({ name: v.name, aliases: [], city: v.city, state: v.stateCode, country: v.countryCode ?? 'US', timezone: v.timezone, ...coords, externalIds: { [DISCOVERY_SOURCE_ID]: v.providerId } }).returning({ id: t.venues.id });
  return row!.id;
}

async function upsertEntity(db: DbOrTx, a: DiscoveredAttraction): Promise<string> {
  const kind = entityKindFor(a.segment);
  const aliases = kind === 'team' ? teamAliases(a.name) : [];
  const league = leagueFor(a);
  const byExternal = await db.select({ id: t.entities.id, aliases: t.entities.aliases }).from(t.entities).where(sql`${t.entities.externalIds} ->> ${DISCOVERY_SOURCE_ID} = ${a.providerId}`);
  // Links are only ever added or refreshed from the provider, never cleared by a response that omits them.
  const links = a.links && Object.keys(a.links).length ? { links: a.links } : {};
  if (byExternal[0]) {
    await db.update(t.entities).set({ name: a.name, aliases: [...new Set([...byExternal[0].aliases, ...aliases])], league, ...links }).where(eq(t.entities.id, byExternal[0].id));
    return byExternal[0].id;
  }
  const slug = slugify(a.name);
  const bySlug = await db.select({ id: t.entities.id, aliases: t.entities.aliases, externalIds: t.entities.externalIds }).from(t.entities).where(eq(t.entities.slug, slug));
  if (bySlug[0]) {
    await db.update(t.entities).set({ externalIds: { ...bySlug[0].externalIds, [DISCOVERY_SOURCE_ID]: a.providerId }, aliases: [...new Set([...bySlug[0].aliases, ...aliases])], league: league ?? undefined, ...links }).where(eq(t.entities.id, bySlug[0].id));
    return bySlug[0].id;
  }
  const [row] = await db.insert(t.entities).values({ kind, name: a.name, slug, aliases, league, homeVenueId: null, externalIds: { [DISCOVERY_SOURCE_ID]: a.providerId }, ...links }).returning({ id: t.entities.id });
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
  else if (e.localDate) {
    // A start with no offset is placed only when the zone gives it one instant: a time in the hour repeated or
    // skipped at a clock change waits for the provider's own instant rather than being guessed (R2-TIME-FOLD-01).
    const at = localTimeInstants(e.localDate, e.localTime ?? '12:00', tz);
    if (at.length !== 1) return null;
    startAt = at[0]!;
  } else return null;
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
  // "X v Y" is how Discovery names some away preseason games ("New York Knicks v Philadelphia 76ers" in
  // Philadelphia), so the name alone isn't proof: a game outside the team's own market is away (TGQA-R8 S03).
  const primaryAttraction = e.attractions[primaryIdx];
  const homeMk = primaryAttraction ? teamHomeMarket(primaryAttraction.name) : null;
  if (homeMk && isHome !== false && e.venue.city && !inMarket({ city: e.venue.city, latitude: e.venue.latitude ?? null, longitude: e.venue.longitude ?? null }, homeMk)) isHome = false;

  const classification = classificationFor(e);
  const category = classification.category;
  const subtype = subtypeFor(e);
  const genre = genreFor(e);
  const sale = { saleStatus: e.statusCode === 'unknown' ? null : e.statusCode, publicSaleStartAt: e.publicSaleStart ? new Date(e.publicSaleStart) : null, publicSaleEndAt: e.publicSaleEnd ? new Date(e.publicSaleEnd) : null, faceMinCents: e.faceMinCents, faceMaxCents: e.faceMaxCents, doorsAt: e.doorsAt ? new Date(e.doorsAt) : null };
  const status = statusFor(e.statusCode);

  const existing = await db.select({ eventId: t.eventSourceMappings.eventId }).from(t.eventSourceMappings).where(and(eq(t.eventSourceMappings.sourceId, DISCOVERY_SOURCE_ID), eq(t.eventSourceMappings.sourceEventId, e.providerEventId)));
  if (existing[0]) {
    await db.update(t.events).set({ name: e.name, category, classification, subtype, genre, ...sale, venueId, primaryEntityId, opponentEntityId, isHome, localStartAt: startAt, status }).where(eq(t.events.id, existing[0].eventId));
    await db.update(t.eventSourceMappings).set({ authoritativeUrl: e.url, verifiedAt: new Date() }).where(and(eq(t.eventSourceMappings.sourceId, DISCOVERY_SOURCE_ID), eq(t.eventSourceMappings.sourceEventId, e.providerEventId)));
    return { eventId: existing[0].eventId, entityIds };
  }
  const [row] = await db.insert(t.events).values({ name: e.name, category, classification, subtype, genre, ...sale, venueId, primaryEntityId, opponentEntityId, isHome, localStartAt: startAt, status, verifiedSourceId: DISCOVERY_SOURCE_ID, isFixture: false }).returning({ id: t.events.id });
  await db.insert(t.eventSourceMappings).values({ eventId: row!.id, sourceId: DISCOVERY_SOURCE_ID, sourceEventId: e.providerEventId, authoritativeUrl: e.url, role: 'discovery', confidence: 'provider_id', verifiedAt: new Date() }).onConflictDoNothing();
  return { eventId: row!.id, entityIds };
}

export async function callsToday(db: DbOrTx, now = new Date()): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(t.catalogSyncs).where(and(eq(t.catalogSyncs.sourceId, DISCOVERY_SOURCE_ID), gte(t.catalogSyncs.syncedAt, dayStart), sql`${t.catalogSyncs.status} not in ('skipped_fresh', 'skipped_budget')`));
  return r?.n ?? 0;
}

/**
 * Whether this same search ran recently enough to trust the catalog. "Same" is the keyword, the place key
 * (a city, a geo point and radius, a state, or none for a national search) and a window at least as wide:
 * a search around New York says nothing about Connecticut, and a fresh sync of October says nothing about March.
 */
async function recentlySynced(db: DbOrTx, keyword: string, city: string | null, window: { from: string | null; to: string | null }, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - SYNC_FRESHNESS_HOURS * 3_600_000);
  const c = t.catalogSyncs;
  const rows = await db
    .select({ id: c.id })
    .from(c)
    .where(
      and(
        eq(c.sourceId, DISCOVERY_SOURCE_ID),
        eq(c.keywordNormalized, keyword),
        city ? sql`lower(coalesce(${c.city}, '')) = ${city.toLowerCase()}` : sql`${c.city} is null`,
        window.from ? sql`(${c.windowFrom} is null or ${c.windowFrom} <= ${window.from})` : sql`${c.windowFrom} is null`,
        window.to ? sql`(${c.windowTo} is null or ${c.windowTo} >= ${window.to})` : sql`${c.windowTo} is null`,
        gte(c.syncedAt, since),
        eq(c.status, 'success'),
      ),
    )
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
  // A browse has no keyword; its freshness is tracked per classification so one sync serves the next asker.
  // The window is part of that key: a fresh sync of October says nothing about November.
  const keyword = normalizeKeyword(q.keyword) || (q.classificationName ? `classification:${q.classificationName.toLowerCase()}:${q.startDateTime ?? ''}..${q.endDateTime ?? ''}` : '');
  // A geo search is fresh per point and radius, the way a city search is fresh per city, and a state search per
  // state. No place at all is a national search, and only another national search stands in for it.
  const city = q.city ?? (q.geoPoint && q.radiusMiles ? `geo:${q.geoPoint}:${q.radiusMiles}mi` : q.stateCode ? `state:${q.stateCode.toUpperCase()}` : null);
  const record = async (status: SyncOutcome['status'], eventCount: number) => {
    await db.insert(t.catalogSyncs).values({ sourceId: DISCOVERY_SOURCE_ID, keywordNormalized: keyword, city, windowFrom: q.startDateTime ?? null, windowTo: q.endDateTime ?? null, status, eventCount, trigger: q.trigger, syncedAt: now });
  };

  if (!q.force && (await recentlySynced(db, keyword, city, { from: q.startDateTime ?? null, to: q.endDateTime ?? null }, now))) return { status: 'skipped_fresh', eventsSeen: 0, eventsUpserted: 0, entityIds: [] };
  const limit = q.dailyCallLimit ?? DEFAULT_DAILY_CALL_LIMIT;
  if ((await callsToday(db, now)) >= limit) {
    await record('skipped_budget', 0);
    return { status: 'skipped_budget', eventsSeen: 0, eventsUpserted: 0, entityIds: [] };
  }

  const res = await adapter.discoverEvents({ keyword: q.keyword, classificationName: q.classificationName ?? null, city: q.city ?? null, stateCode: q.stateCode ?? null, geoPoint: q.geoPoint ?? null, radiusMiles: q.radiusMiles ?? null, startDateTime: q.startDateTime ?? null, endDateTime: q.endDateTime ?? null, size: q.size });
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
