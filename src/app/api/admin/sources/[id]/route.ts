import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import * as t from '@/lib/db/schema';
import { adminRoute } from '@/lib/admin/api';
import { audit } from '@/lib/util/audit';

export const dynamic = 'force-dynamic';
const Body = z.object({
  implementation: z.enum(['not_integrated', 'manual', 'fixture', 'ticketmaster_discovery']),
  enabled: z.boolean(),
  accessApprovalEvidence: z.string().min(10).max(2000).nullable(),
  monitoringAllowed: z.boolean(),
  retentionDays: z.number().int().positive().max(365).nullable(),
  dailyCallLimit: z.number().int().positive().nullable(),
});

/** Source activation (admin). Enabling a non-fixture adapter requires written access-approval evidence. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return adminRoute(req, { role: 'admin', body: Body }, async ({ staff, body }) => {
    const { id } = await ctx.params;
    const { db } = await getDb();
    const [src] = await db.select().from(t.sourceRegistry).where(eq(t.sourceRegistry.id, id));
    if (!src) return Response.json({ error: 'not_found' }, { status: 404 });
    if (body.enabled && body.implementation !== 'fixture' && body.implementation !== 'manual' && !body.accessApprovalEvidence) return Response.json({ error: 'access_approval_evidence_required' }, { status: 422 });
    if (body.implementation === 'fixture' && env().APP_MODE !== 'fixture') return Response.json({ error: 'fixture_adapters_only_in_fixture_mode' }, { status: 422 });
    await db
      .insert(t.adapterConfigs)
      .values({ sourceId: id, implementation: body.implementation, enabled: body.enabled, accessApprovalEvidence: body.accessApprovalEvidence, monitoringAllowed: body.monitoringAllowed, retentionDays: body.retentionDays, dailyCallLimit: body.dailyCallLimit, reviewedBy: staff.userId, reviewedAt: new Date() })
      .onConflictDoUpdate({ target: t.adapterConfigs.sourceId, set: { implementation: body.implementation, enabled: body.enabled, accessApprovalEvidence: body.accessApprovalEvidence, monitoringAllowed: body.monitoringAllowed, retentionDays: body.retentionDays, dailyCallLimit: body.dailyCallLimit, reviewedBy: staff.userId, reviewedAt: new Date(), updatedAt: new Date() } });
    // Registry research evidence is never overwritten on activation; integration status is tracked separately.
    await audit(db, { actor: staff.userId, action: 'source.activation_changed', entityKind: 'source', entityId: id, diff: body });
    return Response.json({ ok: true });
  });
}
