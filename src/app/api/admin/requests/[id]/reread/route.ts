import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { adminRoute } from '@/lib/admin/api';
import { enqueueOutbox } from '@/lib/intake/outbox';
import { audit } from '@/lib/util/audit';

export const dynamic = 'force-dynamic';
const Body = z.object({ idempotencyKey: z.string().min(8).max(128) });

/**
 * POST — read the customer's latest email again, from the start (extraction, then research), for a request
 * handed to a person before it was ever read: its AI budget was used up, or the model kept failing. Enqueued
 * once per idempotency key; the "a person is picking this up" email is not sent again (its key is per request).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    const { db } = await getDb();
    const [r] = await db.select().from(t.requests).where(eq(t.requests.id, id));
    if (!r) return Response.json({ error: 'not_found' }, { status: 404 });
    const [msg] = await db.select({ id: t.messages.id }).from(t.messages).where(and(eq(t.messages.conversationId, r.conversationId), eq(t.messages.direction, 'inbound'))).orderBy(desc(t.messages.receivedAt)).limit(1);
    if (!msg) return Response.json({ error: 'no_inbound_message' }, { status: 422 });
    const res = await db.transaction((tx) => enqueueOutbox(tx, { eventType: 'request.interpret', eventKey: `interpret:${msg.id}:reread:${body.idempotencyKey}`, entityId: id, payload: { messageId: msg.id, requestId: id } }));
    await audit(db, { actor: staff.userId, action: 'request.reread_requested', entityKind: 'request', entityId: id, revision: r.currentRevision, diff: { messageId: msg.id, enqueued: res.inserted } });
    return Response.json({ enqueued: res.inserted }, { status: res.inserted ? 202 : 200 });
  });
}
