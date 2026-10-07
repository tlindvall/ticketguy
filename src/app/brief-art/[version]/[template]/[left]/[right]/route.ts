import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { brandAssets } from '@/lib/db/schema';
import { BANNER_SPORTS, BANNER_VERSION, sendable } from '@/lib/brand/assets';
import { renderBanner, type BannerSide, type BannerTemplate } from '@/lib/brand/banner';

export const dynamic = 'force-dynamic';

const SLUG = /^[a-z0-9-]{1,80}$/;
/** Drawn banners, by URL: a matchup is drawn once per process, then served from memory. */
const cache = new Map<string, Buffer>();
const CACHE_MAX = 300;

/**
 * The ticket brief's banner image (brand/banner.ts): /brief-art/v1/hockey/new-york-rangers/new-york-islanders.jpg,
 * with "_" for a side we don't know. It draws only teams (or, for theater, productions) we hold a row for, and a logo
 * only when its rights allow it in email, so the URL can't be used to draw anything else.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ version: string; template: string; left: string; right: string }> }) {
  const p = await ctx.params;
  const right = p.right.replace(/\.jpg$/, '');
  const template = p.template as BannerTemplate;
  const kind = template === 'theater' ? 'production' : 'team';
  if (p.version !== BANNER_VERSION || !p.right.endsWith('.jpg') || !(template === 'theater' || BANNER_SPORTS.includes(template as never)) || !SLUG.test(p.left) || !(right === '_' || SLUG.test(right))) {
    return new Response('Not found', { status: 404 });
  }
  const key = `${template}/${p.left}/${right}`;
  let jpeg = cache.get(key);
  if (!jpeg) {
    const { db } = await getDb();
    const keys = right === '_' ? [p.left] : [p.left, right];
    const rows = await db.select().from(brandAssets).where(and(eq(brandAssets.kind, kind), inArray(brandAssets.key, keys)));
    const side = (k: string): BannerSide | null => {
      const r = rows.find((x) => x.key === k);
      return r?.primaryColor ? { primaryColor: r.primaryColor, secondaryColor: r.secondaryColor, logoPath: sendable(r) && r.imageKind === 'logo' && r.imageUrl?.startsWith('/') ? r.imageUrl : null } : null;
    };
    const l = side(p.left);
    const r = right === '_' ? null : side(right);
    if (!l || (right !== '_' && !r)) return new Response('Not found', { status: 404 });
    jpeg = await renderBanner(template, l, r);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, jpeg);
  }
  return new Response(new Uint8Array(jpeg), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800', 'Content-Length': String(jpeg.byteLength) } });
}
