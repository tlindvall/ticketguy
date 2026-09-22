import { z } from 'zod';
import { adminRoute } from '@/lib/admin/api';
import { getConcierge } from '@/lib/services';

export const dynamic = 'force-dynamic';
const Body = z.object({ reason: z.string().min(2).max(500) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    const c = await getConcierge();
    await c.cancelWatch({ watchId: id, actor: staff.userId, reason: body.reason });
    return Response.json({ ok: true });
  });
}
