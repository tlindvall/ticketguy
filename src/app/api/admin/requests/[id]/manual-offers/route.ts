import { z } from 'zod';
import { adminRoute } from '@/lib/admin/api';
import { getConcierge } from '@/lib/services';
import { validateUrlSyntax } from '@/lib/security/url-safety';
import { registryIds } from '@/lib/sources/registry';

export const dynamic = 'force-dynamic';
const Body = z.object({
  sourceId: z.string(),
  sourceUrl: z.string().url(),
  observedAt: z.string().datetime(),
  quantity: z.number().int().positive(),
  section: z.string().nullable(),
  row: z.string().nullable(),
  seatsTogether: z.boolean().nullable(),
  seatClass: z.string().nullable(),
  baseTotalCents: z.number().int().min(0).nullable(),
  payableTotalCents: z.number().int().min(0).nullable(),
  feesKnown: z.boolean(),
  taxKnown: z.boolean(),
  deliveryMethod: z.string().nullable(),
  restrictions: z.array(z.string()).default([]),
  evidenceNote: z.string().min(3).max(2000),
});

/** POST — staff-entered manual evidence. Not a URL fetch proxy; the URL is validated and stored as evidence only. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    if (!registryIds().has(body.sourceId)) return Response.json({ error: 'unknown_source' }, { status: 422 });
    const u = validateUrlSyntax(body.sourceUrl);
    if (!u.ok) return Response.json({ error: 'unsafe_url', reason: u.reason }, { status: 422 });
    const c = await getConcierge();
    const r = await c.addManualOffer({ staffUserId: staff.userId, requestId: id, ...body, observedAt: new Date(body.observedAt) });
    return Response.json(r, { status: 201 });
  });
}
