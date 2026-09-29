import { runOutboxBatch } from '@/inngest/functions';
import { cronAuthorized } from '@/lib/util/cron-auth';

export const dynamic = 'force-dynamic';

/** Server-only scheduler endpoint (Render cron or Inngest). Bearer INTERNAL_CRON_SECRET; safe to repeat. */
export async function POST(req: Request) {
  if (!cronAuthorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const r = await runOutboxBatch(50);
  return Response.json(r);
}
