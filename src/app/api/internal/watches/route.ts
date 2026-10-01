import { env } from '@/lib/config/env';
import { getConcierge } from '@/lib/services';
import { cronAuthorized } from '@/lib/util/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Due price watches, for a scheduler other than Inngest (a Render cron hitting this every 5 to 15 minutes), the
 * same work as `evaluate-due-watches`. Bearer INTERNAL_CRON_SECRET. Run one scheduler, not both: a repeat can't
 * duplicate an alert (its dedupe key is unique), but it can spend another paid SeatData read (DECISION_LOG #62).
 */
export async function POST(req: Request) {
  if (!cronAuthorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const e = env();
  if (!e.WATCH_SEND_ENABLED && e.APP_MODE !== 'fixture') return Response.json({ skipped: 'watches_disabled' });
  const c = await getConcierge();
  return Response.json(await c.evaluateDueWatches(20));
}
