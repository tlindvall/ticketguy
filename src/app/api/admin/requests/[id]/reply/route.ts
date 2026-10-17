import { z } from 'zod';
import { adminRoute } from '@/lib/admin/api';
import { getConcierge } from '@/lib/services';

export const dynamic = 'force-dynamic';
const Body = z.object({ heldId: z.string().uuid().nullable().default(null), body: z.string().min(1).max(20_000) });

/**
 * POST — a person answers the customer in their thread: the reply the answer gate held, as drafted or edited, or their own
 * words. Sent as a staff reply; the request is marked answered.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    const c = await getConcierge();
    const r = await c.sendStaffReply({ requestId: id, heldId: body.heldId, body: body.body, staffUserId: staff.userId });
    if (!r.ok) return Response.json({ error: r.reason }, { status: r.status });
    return Response.json(r);
  });
}
