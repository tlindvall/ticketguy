import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { adminRoute } from '@/lib/admin/api';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { audit } from '@/lib/util/audit';

export const dynamic = 'force-dynamic';

/**
 * Staff record an outcome that didn't arrive by email: a purchase an affiliate network confirmed (from its
 * dashboard or report), or what a customer told us another way. Each is stored as the kind of evidence it is.
 */
const Body = z.object({
  kind: z.enum(['affiliate_confirmed_purchase', 'user_reported_purchase', 'user_reported_no_purchase']),
  note: z.string().min(3).max(1000),
  network: z.string().max(60).nullable().optional(),
  amountCents: z.number().int().min(0).nullable().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    const { db } = await getDb();
    const [r] = await db.select({ id: t.requests.id }).from(t.requests).where(eq(t.requests.id, id));
    if (!r) return Response.json({ error: 'not_found' }, { status: 404 });
    const source = body.kind === 'affiliate_confirmed_purchase' ? 'affiliate_report' : 'staff';
    const [row] = await db.insert(t.requestOutcomes).values({ requestId: id, kind: body.kind, source, details: { note: body.note, network: body.network ?? null, amountCents: body.amountCents ?? null }, actor: staff.userId, at: new Date() }).returning({ id: t.requestOutcomes.id });
    await audit(db, { actor: staff.userId, action: 'request.outcome_recorded', entityKind: 'request', entityId: id, diff: { kind: body.kind, source } });
    return Response.json({ id: row!.id }, { status: 201 });
  });
}
