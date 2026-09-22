import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { adminRoute } from '@/lib/admin/api';

export const dynamic = 'force-dynamic';

/** GET /api/admin/requests?state=&cursor=&limit= — keyset pagination on created_at,id. */
export async function GET(req: Request) {
  return adminRoute(req, {}, async () => {
    const url = new URL(req.url);
    const state = url.searchParams.get('state');
    const cursor = url.searchParams.get('cursor');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 25)));
    const { db } = await getDb();
    const where = [] as ReturnType<typeof eq>[];
    if (state) where.push(eq(t.requests.state, state));
    if (cursor) where.push(lt(t.requests.createdAt, new Date(cursor)));
    const rows = await db
      .select({ id: t.requests.id, state: t.requests.state, category: t.requests.category, revision: t.requests.currentRevision, createdAt: t.requests.createdAt, updatedAt: t.requests.updatedAt, deadlineAt: t.requests.deadlineAt, owner: t.requests.ownerUserId, ageSeconds: sql<number>`extract(epoch from now() - ${t.requests.updatedAt})::int` })
      .from(t.requests)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(t.requests.createdAt), desc(t.requests.id))
      .limit(limit);
    return Response.json({ items: rows, nextCursor: rows.length === limit ? rows[rows.length - 1]!.createdAt.toISOString() : null });
  });
}
