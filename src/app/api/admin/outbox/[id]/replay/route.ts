import { getDb } from '@/lib/db';
import { adminRoute } from '@/lib/admin/api';
import { replayDead } from '@/lib/intake/outbox';
import { audit } from '@/lib/util/audit';

export const dynamic = 'force-dynamic';

/** Replays a dead-lettered outbox row with its ORIGINAL event key (idempotent downstream). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { role: 'admin' }, async ({ staff }) => {
    const { id } = await ctx.params;
    const { db } = await getDb();
    const ok = await replayDead(db, id, new Date());
    if (ok) await audit(db, { actor: staff.userId, action: 'outbox.replayed', entityKind: 'outbox_event', entityId: id });
    return Response.json({ ok }, { status: ok ? 200 : 409 });
  });
}
