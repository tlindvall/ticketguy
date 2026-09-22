import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { adminRoute } from '@/lib/admin/api';
import { enqueueOutbox } from '@/lib/intake/outbox';
import { audit } from '@/lib/util/audit';

export const dynamic = 'force-dynamic';
const Body = z.object({ expectedRevision: z.number().int().positive(), idempotencyKey: z.string().min(8).max(128) });

/** POST — re-run research for the current revision; enqueued once per idempotency key (409 on stale revision). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    const { db } = await getDb();
    const [r] = await db.select().from(t.requests).where(eq(t.requests.id, id));
    if (!r) return Response.json({ error: 'not_found' }, { status: 404 });
    if (r.currentRevision !== body.expectedRevision) return Response.json({ error: 'revision_conflict', currentRevision: r.currentRevision }, { status: 409 });
    if (!r.eventId) return Response.json({ error: 'event_unresolved' }, { status: 422 });
    const res = await db.transaction((tx) => enqueueOutbox(tx, { eventType: 'research.requested', eventKey: `research:${id}:${r.currentRevision}:${body.idempotencyKey}`, entityId: id, revision: r.currentRevision, payload: { requestId: id, revision: r.currentRevision } }));
    await audit(db, { actor: staff.userId, action: 'request.research_requested', entityKind: 'request', entityId: id, revision: r.currentRevision, diff: { enqueued: res.inserted } });
    return Response.json({ enqueued: res.inserted }, { status: res.inserted ? 202 : 200 });
  });
}
