import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { brandAssets, previewImages } from '@/lib/db/schema';
import { SENDABLE_RIGHTS } from '@/lib/brand/assets';

export const dynamic = 'force-dynamic';

const FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/;

/**
 * An event's preview image (#179): our resized copy, /event-art/<asset id>.jpg. Only a copy whose rights allow it in
 * a sent email is served, so the URL can't be used to show anything else.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const m = FILE.exec((await ctx.params).file);
  if (!m) return new Response('Not found', { status: 404 });
  const { db } = await getDb();
  const [row] = await db
    .select({ bytes: previewImages.bytes, mime: previewImages.mimeType, rights: brandAssets.rights })
    .from(previewImages)
    .innerJoin(brandAssets, eq(brandAssets.id, previewImages.assetId))
    .where(eq(previewImages.assetId, m[1]!));
  if (!row || !(SENDABLE_RIGHTS as readonly string[]).includes(row.rights)) return new Response('Not found', { status: 404 });
  const bytes = new Uint8Array(row.bytes);
  return new Response(bytes, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=604800', 'Content-Length': String(bytes.byteLength) } });
}
