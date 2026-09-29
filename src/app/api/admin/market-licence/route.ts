import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { adminRoute } from '@/lib/admin/api';
import { audit } from '@/lib/util/audit';
import { SEATDATA_DATASET_ID } from '@/lib/market/series';
import { ensureMarketDatasets } from '@/lib/market/tracker';

export const dynamic = 'force-dynamic';

const Body = z.object({
  status: z.enum(['quarantined', 'approved', 'revoked']),
  tracking: z.boolean(),
  benchmark: z.boolean(),
  advice: z.boolean(),
  customerDisplay: z.boolean(),
  licenseReference: z.string().max(2000).nullable(),
  rawRetentionUntil: z.string().datetime().nullable(),
});

/**
 * The SeatData licence record (admin). Each use is its own switch, because the licence grants them
 * separately: collecting and keeping data (tracking), computing typical prices (benchmark), letting it steer
 * buy/wait (advice), and showing numbers from it to customers (customer display). Approving anything needs a
 * written reference to what allows it.
 */
export async function POST(req: Request) {
  return adminRoute(req, { role: 'admin', body: Body }, async ({ staff, body }) => {
    const { db } = await getDb();
    await ensureMarketDatasets(db);
    const uses = [body.tracking && 'tracking', body.benchmark && 'benchmark', body.advice && 'advice', body.customerDisplay && 'customer_display'].filter((x): x is string => !!x);
    if (body.status === 'approved' && (!body.licenseReference || body.licenseReference.trim().length < 10)) return Response.json({ error: 'licence_reference_required' }, { status: 422 });
    if ((body.advice || body.customerDisplay) && !body.tracking) return Response.json({ error: 'advice_and_display_need_tracking' }, { status: 422 });
    await db.update(t.marketDatasets).set({ status: body.status, approvedUses: uses, licenseReference: body.licenseReference, rawRetentionUntil: body.rawRetentionUntil ? new Date(body.rawRetentionUntil) : null, derivedRetentionUntil: body.rawRetentionUntil ? new Date(body.rawRetentionUntil) : null, approvedBy: staff.userId }).where(eq(t.marketDatasets.id, SEATDATA_DATASET_ID));
    await audit(db, { actor: staff.userId, action: 'market.licence_changed', entityKind: 'dataset', entityId: SEATDATA_DATASET_ID, diff: { status: body.status, uses } });
    return Response.json({ ok: true });
  });
}
