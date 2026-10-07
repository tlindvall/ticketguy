import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import { brandAssets } from '@/lib/db/schema';
import { isLiveMusic } from '@/lib/domain/event-noun';
import type { Sport } from './teams';

/**
 * The artwork at the top of a ticket brief (design of Oct 6): what the event looks like, never where the seats are.
 * A game is a banner we draw for its sport with both teams' colours and logos (banner.ts, served at /brief-art/…);
 * a show is its performer's or production's image, else the venue's, else a band in a show's colours, else our
 * concert artwork. With none of those there is no artwork, not a stand-in.
 *
 * An image is used only when its rights allow it in a sent email ('approved', 'provider_terms', 'licensed').
 * 'unreviewed' ones (provider images until staff confirm the terms) are left out; colours and names are facts.
 */
export type BrandAsset = Pick<typeof brandAssets.$inferSelect, 'kind' | 'key' | 'name' | 'shortName' | 'league' | 'sport' | 'aliases' | 'imageUrl' | 'imageKind' | 'primaryColor' | 'secondaryColor' | 'rights'>;

export const SENDABLE_RIGHTS = ['approved', 'provider_terms', 'licensed'] as const;
export const sendable = (a: Pick<BrandAsset, 'rights' | 'imageUrl'> | undefined): boolean => !!a?.imageUrl && (SENDABLE_RIGHTS as readonly string[]).includes(a.rights);

/** Our concert artwork, served by the app itself (public/email). */
export const CONCERT_ARTWORK_PATH = '/email/ticket-brief-concert.jpg';
/** Bumped when the banner design changes, so mail clients and caches fetch the new one. */
export const BANNER_VERSION = 'v1';
export const BANNER_SPORTS: readonly Sport[] = ['football', 'basketball', 'hockey', 'baseball', 'soccer'];

const LEAGUE_SPORT: Record<string, Sport> = { nfl: 'football', ncaaf: 'football', nba: 'basketball', wnba: 'basketball', ncaab: 'basketball', nhl: 'hockey', mlb: 'baseball', mls: 'soccer', soccer: 'soccer' };

/**
 * The sport a game is played in: the category when it names a league, else the provider's genre ("Football" for a
 * college game filed as ncaa_regular). Null when neither says: no banner is better than the wrong sport's.
 */
export function sportFor(category: string, genre: string | null | undefined): Sport | null {
  const byLeague = LEAGUE_SPORT[category];
  if (byLeague) return byLeague;
  const g = (genre ?? '').toLowerCase();
  if (/\bfootball\b/.test(g) && !/soccer/.test(g)) return 'football';
  if (/basketball/.test(g)) return 'basketball';
  if (/hockey/.test(g)) return 'hockey';
  if (/baseball/.test(g)) return 'baseball';
  if (/soccer/.test(g)) return 'soccer';
  return null;
}

/** "Michigan Wolverines Men's Basketball" → "michigan-wolverines": a school is one row whatever the sport. */
const SPORT_SUFFIX = /-(?:mens|womens|men-s|women-s)?-?(?:football|basketball|baseball|softball|hockey|ice-hockey|soccer|volleyball|lacrosse)$/;
export function teamKeys(slug: string): string[] {
  const bare = slug.replace(SPORT_SUFFIX, '');
  return bare && bare !== slug ? [slug, bare] : [slug];
}

export type ArtSubject = {
  category: string;
  genre?: string | null;
  primary: { kind: string; slug: string; name: string } | null;
  opponent: { kind: string; slug: string; name: string } | null;
  /** The venue's asset keys, e.g. "ticketmaster:KovZpZA7AAEA". */
  venueKeys: string[];
};

/** Finds a team by its slug or any alias, with a sport suffix stripped for a school. */
function findTeam(rows: BrandAsset[], slug: string): BrandAsset | undefined {
  const keys = teamKeys(slug);
  return rows.find((r) => r.kind === 'team' && keys.includes(r.key)) ?? rows.find((r) => r.kind === 'team' && r.aliases.some((a) => keys.includes(a)));
}

/**
 * The artwork's URL: a path on this app ("/brief-art/v1/hockey/new-york-rangers/new-york-islanders.jpg") or an https
 * image elsewhere. Pure: the rows are loaded by loadBriefArtwork.
 */
export function chooseArtwork(rows: BrandAsset[], s: ArtSubject): string | null {
  const sport = sportFor(s.category, s.genre);
  if (sport) {
    const left = s.primary ? findTeam(rows, s.primary.slug) : undefined;
    const right = s.opponent ? findTeam(rows, s.opponent.slug) : undefined;
    // The customer's team first; one known side still makes a banner, in its colours.
    const [a, b] = left ? [left, right] : [right, undefined];
    if (!a) return null;
    return `/brief-art/${BANNER_VERSION}/${sport}/${a.key}/${b?.key ?? '_'}.jpg`;
  }
  const own = s.primary ? rows.find((r) => r.kind === s.primary!.kind && r.key === s.primary!.slug) : undefined;
  if (own && sendable(own) && own.imageKind !== 'logo') return own.imageUrl;
  for (const key of s.venueKeys) {
    const v = rows.find((r) => r.kind === 'venue' && r.key === key);
    if (v && sendable(v)) return v.imageUrl;
  }
  // A production with its own colours (a Broadway show) gets a stage banner in them.
  if (own?.kind === 'production' && own.primaryColor) return `/brief-art/${BANNER_VERSION}/theater/${own.key}/_.jpg`;
  if (isLiveMusic(s.category)) return CONCERT_ARTWORK_PATH;
  return null;
}

export async function loadBriefArtwork(db: DbOrTx, s: ArtSubject): Promise<string | null> {
  const slugs = [s.primary, s.opponent].filter((x): x is NonNullable<typeof x> => !!x).flatMap((e) => teamKeys(e.slug));
  const conds = [
    ...(slugs.length ? [inArray(brandAssets.key, slugs), sql`${brandAssets.aliases} ?| array[${sql.join(slugs.map((k) => sql`${k}`), sql`, `)}]::text[]`] : []),
    ...(s.venueKeys.length ? [and(eq(brandAssets.kind, 'venue'), inArray(brandAssets.key, s.venueKeys))] : []),
  ];
  const rows = conds.length ? await db.select().from(brandAssets).where(or(...conds)) : [];
  return chooseArtwork(rows, s);
}

/** A venue's asset keys from its provider ids: { ticketmaster: 'KovZpZA7AAEA' } → ['ticketmaster:KovZpZA7AAEA']. */
export function venueKeys(externalIds: Record<string, string> | null | undefined): string[] {
  return Object.entries(externalIds ?? {}).map(([k, v]) => `${k}:${v}`);
}

/**
 * A provider's image for a team, performer or venue. It never replaces a row staff, the seed or the team file wrote:
 * only an earlier row from the same provider is refreshed. Stored 'unreviewed' until staff confirm the provider's
 * terms cover showing it in our email.
 */
export async function upsertProviderImage(db: DbOrTx, a: { kind: string; key: string; name: string; source: string; image: { url: string; width: number | null; height: number | null } }): Promise<void> {
  await db
    .insert(brandAssets)
    .values({ kind: a.kind, key: a.key, name: a.name, imageUrl: a.image.url, imageKind: 'photo', imageWidth: a.image.width, imageHeight: a.image.height, source: a.source, rights: 'unreviewed' })
    .onConflictDoUpdate({
      target: [brandAssets.kind, brandAssets.key],
      set: { name: a.name, imageUrl: a.image.url, imageWidth: a.image.width, imageHeight: a.image.height, updatedAt: new Date() },
      setWhere: eq(brandAssets.source, a.source),
    });
}
