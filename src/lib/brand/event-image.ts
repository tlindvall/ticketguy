import { and, eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import type { DbOrTx } from '@/lib/db';
import { brandAssets, eventSourceMappings, previewImages } from '@/lib/db/schema';
import { safeFetch } from '@/lib/security/url-safety';
import { SENDABLE_RIGHTS } from './assets';

/**
 * The event preview card's image (#179), the way a chat app unfurls a link. In order:
 *  1. the provider's own image for the event (Ticketmaster Discovery `images[]`, kept at catalog sync);
 *  2. the Open Graph image of the official event page we link to (a mapping in our catalog, never a link a customer
 *     sent and never a press or blog page: editorial photos are not ours to use);
 *  3. nothing, and the caller falls back to today's banner (brand/assets.ts).
 * Each is fetched once, resized to 600px wide and kept as our own copy (preview_images), served from
 * /event-art/<asset id>.jpg so the email doesn't hotlink a CDN, leak opens or break when a link expires.
 * A failure of any kind means the fallback, never an error.
 */

export const PREVIEW_WIDTH = 600;
export const FETCH_LIMITS = { timeoutMs: 3000, maxRedirects: 3, maxBytes: 2 * 1024 * 1024 } as const;
/** A page that had no usable image is asked again after this long; a stored copy is kept. */
export const MISS_TTL_MS = 7 * 24 * 3600_000;
const MIN_SOURCE_WIDTH = 300;

export const eventAssetKey = (eventId: string) => `event:${eventId}`;
export const previewPath = (assetId: string) => `/event-art/${assetId}.jpg`;

export type PreviewDeps = {
  /** Network fetch for images and pages. Absent (tests, fixture mode, the eval): only stored copies are used. */
  fetchImpl?: typeof fetch;
  /** DNS lookup used to refuse private destinations; tests inject one. */
  resolver?: (host: string) => Promise<string[]>;
  now?: () => Date;
};

export type OpenGraph = { image: string | null; title: string | null; description: string | null };

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? null) : null;
};
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** og:image (or its secure_url), og:title and og:description from a page's <meta> tags, the image made absolute. */
export function parseOpenGraph(html: string, pageUrl: string): OpenGraph {
  const found: Record<string, string> = {};
  for (const m of html.slice(0, 512 * 1024).matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') ?? attr(m[0], 'name') ?? '').toLowerCase();
    const content = attr(m[0], 'content');
    if (content && ['og:image', 'og:image:secure_url', 'og:image:url', 'og:title', 'og:description'].includes(key) && !(key in found)) found[key] = decode(content.trim());
  }
  const raw = found['og:image:secure_url'] ?? found['og:image'] ?? found['og:image:url'] ?? null;
  let image: string | null = null;
  if (raw) {
    try {
      const u = new URL(raw, pageUrl);
      image = u.protocol === 'https:' ? u.href : null;
    } catch {
      image = null;
    }
  }
  return { image, title: found['og:title'] ?? null, description: found['og:description'] ?? null };
}

/** The body, or null once it passes the byte cap or the deadline (the redirect timeout doesn't cover the read). */
async function readCapped(res: Response, maxBytes: number, deadline: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      const next = await Promise.race([reader.read(), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), left))]);
      if (next === 'timeout') return null;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(next.value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** A guarded GET (https, no private destinations, each redirect re-checked, 3 hops, 3 seconds, 2 MB). */
export async function guardedGet(url: string, accept: RegExp, deps: PreviewDeps): Promise<{ bytes: Uint8Array; finalUrl: string; type: string } | null> {
  if (!deps.fetchImpl) return null;
  const deadline = Date.now() + FETCH_LIMITS.timeoutMs;
  const res = await safeFetch(url, { maxRedirects: FETCH_LIMITS.maxRedirects, timeoutMs: FETCH_LIMITS.timeoutMs, resolver: deps.resolver, fetchImpl: deps.fetchImpl }).catch(() => null);
  if (!res?.ok || !res.response.ok) return null;
  const type = (res.response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!accept.test(type)) return null;
  const bytes = await readCapped(res.response, FETCH_LIMITS.maxBytes, deadline).catch(() => null);
  return bytes ? { bytes, finalUrl: res.finalUrl.href, type } : null;
}

/** Our copy of an image: 600px wide JPEG, never enlarged; null for anything sharp can't read or too small to show. */
export async function resizeForEmail(bytes: Uint8Array): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  try {
    const img = sharp(bytes, { limitInputPixels: 40_000_000 });
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < MIN_SOURCE_WIDTH) return null;
    const out = await img.rotate().resize({ width: PREVIEW_WIDTH, withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    return { bytes: new Uint8Array(out.data), width: out.info.width, height: out.info.height };
  } catch {
    return null;
  }
}

/** The provider's image for an event, kept at catalog sync. A row that already has our copy keeps it. */
export async function upsertEventImage(db: DbOrTx, a: { eventId: string; name: string; source: string; imageUrl: string; width: number | null; height: number | null; sourceUrl: string | null }): Promise<void> {
  // Ticketmaster's API terms cover showing its event images (owner's call in #179), so they go in as provider_terms.
  await db
    .insert(brandAssets)
    .values({ kind: 'event', key: eventAssetKey(a.eventId), name: a.name, imageUrl: a.imageUrl, imageKind: 'photo', imageWidth: a.width, imageHeight: a.height, source: a.source, rights: 'provider_terms', sourceUrl: a.sourceUrl })
    .onConflictDoUpdate({
      target: [brandAssets.kind, brandAssets.key],
      set: { name: a.name, imageUrl: a.imageUrl, imageWidth: a.width, imageHeight: a.height, source: a.source, rights: 'provider_terms', sourceUrl: a.sourceUrl, updatedAt: new Date() },
      // Only over nothing (a recorded miss) or an earlier provider row: staff's or the Open Graph copy stay.
      where: sql`${brandAssets.imageUrl} is null or ${brandAssets.source} = ${a.source}`,
    });
}

type AssetRow = typeof brandAssets.$inferSelect;

async function storeCopy(db: DbOrTx, asset: AssetRow, sourceImageUrl: string, deps: PreviewDeps): Promise<boolean> {
  const got = await guardedGet(sourceImageUrl, /^image\/(?:jpeg|png|webp|gif|avif)$/, deps);
  const copy = got ? await resizeForEmail(got.bytes) : null;
  if (!copy) return false;
  await db
    .insert(previewImages)
    .values({ assetId: asset.id, mimeType: 'image/jpeg', width: copy.width, height: copy.height, bytes: copy.bytes, sourceImageUrl, fetchedAt: deps.now?.() ?? new Date() })
    .onConflictDoUpdate({ target: previewImages.assetId, set: { width: copy.width, height: copy.height, bytes: copy.bytes, sourceImageUrl, fetchedAt: deps.now?.() ?? new Date() } });
  return true;
}

/** The official pages we link to for this event: catalog mappings only, never a link a customer sent. */
async function officialPages(db: DbOrTx, eventId: string): Promise<string[]> {
  const rows = await db.select({ url: eventSourceMappings.authoritativeUrl, role: eventSourceMappings.role }).from(eventSourceMappings).where(eq(eventSourceMappings.eventId, eventId));
  return rows
    .filter((r) => r.url && /^https:\/\//.test(r.url))
    .sort((x, y) => (x.role === 'official' ? -1 : 0) - (y.role === 'official' ? -1 : 0))
    .map((r) => r.url!);
}

export type EventPreview = { url: string; alt: string | null; width: number; height: number };

/**
 * Our URL for the event's preview image, fetching and keeping a copy the first time; null when there's none we may
 * send (the caller then uses the banner). Never throws.
 */
export async function eventPreview(db: DbOrTx, event: { id: string; name: string }, appUrl: string, deps: PreviewDeps = {}): Promise<EventPreview | null> {
  try {
    const now = deps.now?.() ?? new Date();
    const key = eventAssetKey(event.id);
    const [asset] = await db.select().from(brandAssets).where(and(eq(brandAssets.kind, 'event'), eq(brandAssets.key, key)));
    const ready = async (a: AssetRow): Promise<EventPreview | null> => {
      if (!(SENDABLE_RIGHTS as readonly string[]).includes(a.rights)) return null;
      const [p] = await db.select({ width: previewImages.width, height: previewImages.height }).from(previewImages).where(eq(previewImages.assetId, a.id));
      return p ? { url: `${appUrl.replace(/\/$/, '')}${previewPath(a.id)}`, alt: null, width: p.width, height: p.height } : null;
    };
    if (asset) {
      const have = await ready(asset);
      if (have) return have;
      // The provider's image, kept at sync: copied now.
      if (asset.imageUrl && (SENDABLE_RIGHTS as readonly string[]).includes(asset.rights) && (await storeCopy(db, asset, asset.imageUrl, deps))) return ready(asset);
      // A page we tried within the week had nothing: not asked again yet.
      if (!asset.imageUrl && now.getTime() - asset.updatedAt.getTime() < MISS_TTL_MS) return null;
    }
    if (!deps.fetchImpl) return null;
    for (const page of await officialPages(db, event.id)) {
      const html = await guardedGet(page, /^text\/html$|^application\/xhtml\+xml$/, deps);
      const og = html ? parseOpenGraph(new TextDecoder().decode(html.bytes), html.finalUrl) : null;
      if (!og?.image) continue;
      const [row] = await db
        .insert(brandAssets)
        .values({ kind: 'event', key, name: event.name, imageUrl: og.image, imageKind: 'photo', source: 'open_graph', rights: 'provider_terms', sourceUrl: html!.finalUrl })
        .onConflictDoUpdate({ target: [brandAssets.kind, brandAssets.key], set: { imageUrl: og.image, source: 'open_graph', rights: 'provider_terms', sourceUrl: html!.finalUrl, updatedAt: now } })
        .returning();
      if (row && (await storeCopy(db, row, og.image, deps))) return ready(row);
    }
    // Nothing usable: recorded, so the pages aren't fetched again for a week.
    await db
      .insert(brandAssets)
      .values({ kind: 'event', key, name: event.name, imageUrl: null, source: 'open_graph', rights: 'unreviewed', updatedAt: now })
      .onConflictDoUpdate({ target: [brandAssets.kind, brandAssets.key], set: { updatedAt: now }, where: sql`${brandAssets.imageUrl} is null` });
    return null;
  } catch {
    return null;
  }
}

/** Stored copies for several events at once (browse lists): ids → our URL. No fetching. */
export async function storedPreviews(db: DbOrTx, eventIds: string[], appUrl: string): Promise<Map<string, string>> {
  if (!eventIds.length) return new Map();
  const rows = await db
    .select({ key: brandAssets.key, id: brandAssets.id, rights: brandAssets.rights })
    .from(brandAssets)
    .innerJoin(previewImages, eq(previewImages.assetId, brandAssets.id))
    .where(and(eq(brandAssets.kind, 'event'), inArray(brandAssets.key, eventIds.map(eventAssetKey))));
  return new Map(rows.filter((r) => (SENDABLE_RIGHTS as readonly string[]).includes(r.rights)).map((r) => [r.key.slice('event:'.length), `${appUrl.replace(/\/$/, '')}${previewPath(r.id)}`]));
}
