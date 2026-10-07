import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db';
import { brandAssets } from '@/lib/db/schema';
import { TEAM_BRANDS } from './teams';

/**
 * Copies the team file (src/lib/brand/teams/*.json) into brand_assets, run after migrations on every deploy. A row the
 * seed or an earlier sync wrote is brought up to date; a row staff edited (source 'staff') is left alone. Logos are
 * ours, hosted under public/, and approved for email by the owner (2026-10-06).
 */
export async function syncTeamBrands(db: DbOrTx): Promise<number> {
  const rows = TEAM_BRANDS.map((t) => ({
    kind: 'team',
    key: t.slug,
    name: t.name,
    shortName: t.shortName,
    league: t.league,
    sport: t.sport,
    aliases: t.aliases,
    imageUrl: t.logo,
    imageKind: t.logo ? 'logo' : null,
    imageWidth: t.logo ? 256 : null,
    imageHeight: t.logo ? 256 : null,
    primaryColor: t.primaryColor,
    secondaryColor: t.secondaryColor,
    source: 'team_file',
    rights: 'approved',
    attribution: 'Self-hosted team logo (owner decision 2026-10-06)',
  }));
  for (let i = 0; i < rows.length; i += 100) {
    await db
      .insert(brandAssets)
      .values(rows.slice(i, i + 100))
      .onConflictDoUpdate({
        target: [brandAssets.kind, brandAssets.key],
        set: {
          name: sql`excluded.name`, shortName: sql`excluded.short_name`, league: sql`excluded.league`, sport: sql`excluded.sport`, aliases: sql`excluded.aliases`,
          imageUrl: sql`excluded.image_url`, imageKind: sql`excluded.image_kind`, imageWidth: sql`excluded.image_width`, imageHeight: sql`excluded.image_height`,
          primaryColor: sql`excluded.primary_color`, secondaryColor: sql`excluded.secondary_color`, source: sql`excluded.source`, rights: sql`excluded.rights`, attribution: sql`excluded.attribution`, updatedAt: new Date(),
        },
        setWhere: sql`${brandAssets.source} in ('seed', 'team_file', 'ticketmaster')`,
      });
  }
  return rows.length;
}
