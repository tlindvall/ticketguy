import { z } from 'zod';
import { adminRoute } from '@/lib/admin/api';
import { getConcierge } from '@/lib/services';

export const dynamic = 'force-dynamic';
const Body = z.object({ expectedRevision: z.number().int().positive(), draftHash: z.string().length(64), note: z.string().max(2000).nullable().default(null) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    const c = await getConcierge();
    const r = await c.approveRecommendation({ recommendationId: id, reviewerUserId: staff.userId, expectedRevision: body.expectedRevision, draftHash: body.draftHash, note: body.note });
    if (!r.ok) return Response.json({ error: r.reason }, { status: r.status });
    return Response.json(r);
  });
}
