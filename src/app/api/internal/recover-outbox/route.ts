import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { runOutboxBatch } from '@/inngest/functions';

export const dynamic = 'force-dynamic';

/** Server-only scheduler endpoint (Render cron or Inngest). Bearer INTERNAL_CRON_SECRET; safe to repeat. */
export async function POST(req: Request) {
  const e = env();
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!e.INTERNAL_CRON_SECRET || provided.length !== e.INTERNAL_CRON_SECRET.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(e.INTERNAL_CRON_SECRET))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const r = await runOutboxBatch(50);
  return Response.json(r);
}
