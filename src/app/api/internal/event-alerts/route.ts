import { getConcierge } from '@/lib/services';
import { cronAuthorized } from '@/lib/util/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Sale and new-date alerts, for a scheduler other than Inngest (a Render cron hitting this hourly).
 * Bearer INTERNAL_CRON_SECRET; safe to repeat: an alert is claimed before it is sent, so it fires once.
 */
export async function POST(req: Request) {
  if (!cronAuthorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const c = await getConcierge();
  return Response.json(await c.evaluateEventAlerts({ limit: 25 }));
}
