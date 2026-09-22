import { adminRoute } from '@/lib/admin/api';
import { getConcierge } from '@/lib/services';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, {}, async ({ staff }) => {
    const { id } = await ctx.params;
    const c = await getConcierge();
    const r = await c.approveWatchAlert({ alertId: id, reviewerUserId: staff.userId });
    return Response.json(r, { status: r.ok ? 200 : 409 });
  });
}
