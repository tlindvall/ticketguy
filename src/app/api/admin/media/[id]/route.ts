import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import { adminRoute } from '@/lib/admin/api';
import { createMediaStore } from '@/lib/media/storage';
import { audit } from '@/lib/util/audit';

export const dynamic = 'force-dynamic';

/** Staff-authorized, no-store media download (A44). Guessing an ID without a staff session yields 401. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, {}, async ({ staff }) => {
    const { id } = await ctx.params;
    const { db } = await getDb();
    const store = createMediaStore(db, env().MEDIA_PROVIDER, env().MEDIA_MAX_TOTAL_BYTES);
    const m = await store.get(id);
    if (!m) return Response.json({ error: 'not_found' }, { status: 404 });
    await audit(db, { actor: staff.userId, action: 'media.downloaded', entityKind: 'media', entityId: id });
    const safeType = m.mimeType.startsWith('image/') || m.mimeType === 'text/plain' ? m.mimeType : 'application/octet-stream';
    return new Response(Buffer.from(m.bytes), { headers: { 'content-type': safeType, 'cache-control': 'no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
  });
}
