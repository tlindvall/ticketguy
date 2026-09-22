import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { adminRoute } from '@/lib/admin/api';
import { audit } from '@/lib/util/audit';

export const dynamic = 'force-dynamic';
const Body = z.object({ reason: z.string().min(2).max(500), resume: z.boolean().default(false) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    const { db } = await getDb();
    const from = body.resume ? 'paused' : 'active';
    const to = body.resume ? 'active' : 'paused';
    const rows = await db.update(t.watches).set({ state: to, generation: sql`${t.watches.generation} + 1` }).where(and(eq(t.watches.id, id), eq(t.watches.state, from))).returning({ id: t.watches.id });
    if (!rows.length) return Response.json({ error: 'state_conflict' }, { status: 409 });
    await audit(db, { actor: staff.userId, action: `watch.${to}`, entityKind: 'watch', entityId: id, diff: { reason: body.reason } });
    return Response.json({ ok: true, state: to });
  });
}
