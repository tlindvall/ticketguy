import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import { brandAssets } from '@/lib/db/schema';
import { SPORT_CATEGORIES } from '@/lib/domain/event-noun';

/**
 * The artwork at the top of a ticket brief (ticket-brief design, Oct 6): what the event looks like, never where the
 * seats are. A game is its two teams side by side in their colours; a show is its performer's or production's
 * image, else the venue's, else our own category artwork; with none of those there is no artwork, not a stand-in.
 *
 * Only an image whose rights allow it goes into a sent email ('provider_terms' or 'licensed'). An 'unreviewed' one
 * shows in previews only, so staff can see what approving it would look like. Colours and names are facts and
 * appear either way.
 */
export type BrandAsset = Pick<typeof brandAssets.$inferSelect, 'kind' | 'key' | 'name' | 'shortName' | 'league' | 'imageUrl' | 'imageKind' | 'imageWidth' | 'imageHeight' | 'primaryColor' | 'secondaryColor' | 'rights'>;

export type MatchupSide = { name: string; shortName: string | null; color: string; textColor: string; logoUrl: string | null };
export type BriefArt =
  | { kind: 'matchup'; left: MatchupSide; right: MatchupSide | null }
  | { kind: 'image'; url: string }
  | { kind: 'band'; color: string; accent: string; textColor: string; label: string };

export type ArtMode = 'send' | 'preview';

/** The small caps label over the event title: the league for a game, the kind of show otherwise. */
const CATEGORY_LABELS: Record<string, string> = {
  nhl: 'NHL', nba: 'NBA', wnba: 'WNBA', nfl: 'NFL', mlb: 'MLB', soccer: 'Soccer', mls: 'MLS',
  concert: 'Concert', club_concert: 'Concert', festival: 'Festival', electronic_nightlife: 'Nightlife',
  broadway: 'Broadway', touring_theater: 'Theater', classical: 'Classical', comedy: 'Comedy', family: 'Family',
};
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? 'Event';
}

/** Which category default applies: our own artwork exists for concerts; the others are colour only. */
function categoryGroup(category: string): 'sports' | 'concert' | 'theater' | 'comedy' | null {
  if (SPORT_CATEGORIES.includes(category) || category === 'wnba') return 'sports';
  if (['concert', 'club_concert', 'festival', 'electronic_nightlife'].includes(category)) return 'concert';
  if (['broadway', 'touring_theater', 'classical'].includes(category)) return 'theater';
  if (category === 'comedy') return 'comedy';
  return null;
}

/** Our generated concert artwork, served by the app itself (public/email). */
export const CONCERT_ARTWORK_PATH = '/email/concert-artwork.jpg';

const HEX = /^#[0-9a-f]{6}$/i;
/** White or ink on a colour, whichever reads (WCAG relative luminance). */
export function textOn(hex: string): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  return lum > 0.4 ? '#142438' : '#ffffff';
}

function usable(a: BrandAsset | undefined, mode: ArtMode, kinds: string[]): string | null {
  if (!a?.imageUrl || !a.imageKind || !kinds.includes(a.imageKind)) return null;
  if (mode === 'send' && a.rights === 'unreviewed') return null;
  return /^https:\/\//.test(a.imageUrl) ? a.imageUrl : null;
}

function side(a: BrandAsset | undefined, fallbackName: string | null, mode: ArtMode): MatchupSide | null {
  const color = a?.primaryColor && HEX.test(a.primaryColor) ? a.primaryColor : null;
  if (!color) return null;
  return { name: a?.name ?? fallbackName ?? '', shortName: a?.shortName ?? null, color, textColor: textOn(color), logoUrl: usable(a, mode, ['logo']) };
}

export type ArtSubject = {
  category: string;
  primary: { kind: string; slug: string; name: string } | null;
  opponent: { kind: string; slug: string; name: string } | null;
  /** The venue's asset keys, e.g. "ticketmaster:KovZpZA7AAEA". */
  venueKeys: string[];
};

/** Pure choice from the rows already loaded; see loadBriefArt for the query. */
export function chooseArt(assets: BrandAsset[], s: ArtSubject, opts: { mode: ArtMode; appUrl: string }): BriefArt | null {
  const find = (kind: string, key: string) => assets.find((a) => a.kind === kind && a.key === key);
  const primary = s.primary ? find(s.primary.kind, s.primary.slug) : undefined;
  const group = categoryGroup(s.category);
  if (group === 'sports') {
    const left = side(primary, s.primary?.name ?? null, opts.mode);
    const right = s.opponent ? side(find(s.opponent.kind, s.opponent.slug), s.opponent.name, opts.mode) : null;
    // One known side still makes a banner; with neither team's colours there is nothing to draw.
    if (left) return { kind: 'matchup', left, right };
    if (right) return { kind: 'matchup', left: right, right: null };
    return null;
  }
  const own = usable(primary, opts.mode, ['photo', 'artwork', 'logo']);
  if (own) return { kind: 'image', url: own };
  for (const key of s.venueKeys) {
    const v = usable(find('venue', key), opts.mode, ['photo', 'artwork']);
    if (v) return { kind: 'image', url: v };
  }
  // A show with its own colours (a Broadway production) gets a band in them, named; better than generic art.
  if (primary?.primaryColor && HEX.test(primary.primaryColor)) {
    const accent = primary.secondaryColor && HEX.test(primary.secondaryColor) ? primary.secondaryColor : '#d7f36b';
    return { kind: 'band', color: primary.primaryColor, accent, textColor: textOn(primary.primaryColor), label: primary.name };
  }
  if (group === 'concert') {
    const base = opts.appUrl.replace(/\/$/, '');
    // A sent email needs an absolute https URL. An empty base is a page on this app (the preview), where the path works.
    if (base === '' || /^https:\/\//.test(base)) return { kind: 'image', url: `${base}${CONCERT_ARTWORK_PATH}` };
  }
  return null;
}

export async function loadBriefArt(db: DbOrTx, s: ArtSubject, opts: { mode: ArtMode; appUrl: string }): Promise<BriefArt | null> {
  const ents = [s.primary, s.opponent].filter((x): x is NonNullable<typeof x> => !!x);
  const conds = [
    ...ents.map((e) => and(eq(brandAssets.kind, e.kind), eq(brandAssets.key, e.slug))),
    ...(s.venueKeys.length ? [and(eq(brandAssets.kind, 'venue'), inArray(brandAssets.key, s.venueKeys))] : []),
  ];
  const rows = conds.length ? await db.select().from(brandAssets).where(or(...conds, sql`false`)) : [];
  return chooseArt(rows, s, opts);
}

/** A venue's asset keys from its provider ids: { ticketmaster: 'KovZpZA7AAEA' } → ['ticketmaster:KovZpZA7AAEA']. */
export function venueKeys(externalIds: Record<string, string> | null | undefined): string[] {
  return Object.entries(externalIds ?? {}).map(([k, v]) => `${k}:${v}`);
}

/**
 * A provider's image for a team, performer or venue, kept for the brief. It never replaces a row staff or the seed
 * wrote: only an earlier provider row is refreshed. Stored 'unreviewed' until staff confirm the provider's terms cover
 * showing it in our email (one update per source, see docs).
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
