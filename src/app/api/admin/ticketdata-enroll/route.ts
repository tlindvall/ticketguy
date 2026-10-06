import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { adminRoute } from '@/lib/admin/api';
import { audit } from '@/lib/util/audit';
import { nowMs } from '@/lib/util/clock';
import { TICKETDATA_PROVIDER } from '@/lib/market/series';
import { ensureTicketDataDataset, ticketDataLicence } from '@/lib/market/ticketdata-sync';

export const dynamic = 'force-dynamic';

const Body = z.object({
  eventId: z.string().uuid(),
  providerEventId: z.string().min(1).max(200),
});

/**
 * Enroll one catalog event for TicketData tracking (admin, investigational). The row starts active and
 * due now, so the next daily sync picks it up; the sync itself still needs the enabled flag and the
 * tracking licence use. Re-enrolling the same event is a no-op.
 */
export async function POST(req: Request) {
  return adminRoute(req, { role: 'admin', body: Body }, async ({ staff, body }) => {
    const { db } = await getDb();
    await ensureTicketDataDataset(db);
    const lic = await ticketDataLicence(db);
    if (!lic.allows('tracking')) return Response.json({ error: 'licence_not_approved_for_tracking', status: lic.status }, { status: 409 });
    const [ev] = await db.select({ id: t.events.id }).from(t.events).where(eq(t.events.id, body.eventId));
    if (!ev) return Response.json({ error: 'event_not_found' }, { status: 404 });
    const [existing] = await db.select({ id: t.trackedEvents.id }).from(t.trackedEvents).where(and(eq(t.trackedEvents.eventId, body.eventId), eq(t.trackedEvents.provider, TICKETDATA_PROVIDER)));
    if (existing) return Response.json({ ok: true, already: true });
    const now = new Date(nowMs());
    await db.insert(t.trackedEvents).values({
      eventId: body.eventId,
      provider: TICKETDATA_PROVIDER,
      providerEventId: body.providerEventId,
      state: 'active',
      reasons: ['staff'],
      nextPollAt: now,
    });
    await audit(db, { actor: staff.userId, action: 'market.ticketdata_enrolled', entityKind: 'tracked_event', entityId: body.eventId, diff: { provider: TICKETDATA_PROVIDER, providerEventId: body.providerEventId } });
    return Response.json({ ok: true });
  });
}
