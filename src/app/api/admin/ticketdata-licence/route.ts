import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { adminRoute } from '@/lib/admin/api';
import { audit } from '@/lib/util/audit';
import { TICKETDATA_DATASET_ID } from '@/lib/market/series';
import { ensureTicketDataDataset } from '@/lib/market/ticketdata-sync';

export const dynamic = 'force-dynamic';

const Body = z.object({
  status: z.enum(['quarantined', 'approved', 'revoked']),
  tracking: z.boolean(),
  benchmark: z.boolean(),
  advice: z.boolean(),
  customerDisplay: z.boolean(),
  alerts: z.boolean().default(false),
  licenseReference: z.string().max(2000).nullable(),
  rawRetentionUntil: z.string().datetime().nullable(),
});

/**
 * The TicketData licence record (admin, investigational vendor lead — ADVICE_ENGINE §3). Each use is its
 * own switch: collecting and keeping get-in series (tracking), computing typical prices (benchmark),
 * letting it steer buy/wait (advice), showing numbers from it to customers (customer display), and
 * emailing customers alerts (alerts). Approving anything needs a written reference to what allows it,
 * and licence terms must be requested and confirmed before any production reliance.
 */
export async function POST(req: Request) {
  return adminRoute(req, { role: 'admin', body: Body }, async ({ staff, body }) => {
    const { db } = await getDb();
    await ensureTicketDataDataset(db);
    const uses = [body.tracking && 'tracking', body.benchmark && 'benchmark', body.advice && 'advice', body.customerDisplay && 'customer_display', body.alerts && 'alerts'].filter((x): x is string => !!x);
    if (body.status === 'approved' && (!body.licenseReference || body.licenseReference.trim().length < 10)) return Response.json({ error: 'licence_reference_required' }, { status: 422 });
    if ((body.advice || body.customerDisplay || body.alerts) && !body.tracking) return Response.json({ error: 'advice_and_display_need_tracking' }, { status: 422 });
    await db.update(t.marketDatasets).set({ status: body.status, approvedUses: uses, licenseReference: body.licenseReference, rawRetentionUntil: body.rawRetentionUntil ? new Date(body.rawRetentionUntil) : null, derivedRetentionUntil: body.rawRetentionUntil ? new Date(body.rawRetentionUntil) : null, approvedBy: staff.userId }).where(eq(t.marketDatasets.id, TICKETDATA_DATASET_ID));
    await audit(db, { actor: staff.userId, action: 'market.licence_changed', entityKind: 'dataset', entityId: TICKETDATA_DATASET_ID, diff: { status: body.status, uses } });
    return Response.json({ ok: true });
  });
}
