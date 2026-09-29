import { runMarketTracking } from '@/inngest/functions';
import { cronAuthorized } from '@/lib/util/cron-auth';

export const dynamic = 'force-dynamic';

/** Resale market tracking for a scheduler other than Inngest (a Render cron, hourly). Bearer INTERNAL_CRON_SECRET; safe to repeat. */
export async function POST(req: Request) {
  if (!cronAuthorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return Response.json(await runMarketTracking());
}
