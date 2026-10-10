import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';
import { schedulerLiveness } from '@/lib/admin/liveness';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { db, driver } = await getDb();
    await db.execute(sql`select 1`);
    const e = env();
    // Scheduler liveness (audit gap 26) is reported, never a failure: Render restarts the service on a failing health
    // check, and a restart doesn't start a stalled dispatcher. A failed read of it is null, not a 503.
    const live = await schedulerLiveness(db, new Date()).catch(() => null);
    return Response.json({ ok: true, driver, appMode: e.APP_MODE, emailSendEnabled: e.EMAIL_SEND_ENABLED, outboxLagSeconds: live?.outboxLagSeconds ?? null, lastDispatchAt: live?.lastDispatchAt ?? null }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.name : 'error' }, { status: 503 });
  }
}
