import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';

/** Scheduler endpoints (Render cron or Inngest) authenticate with `Authorization: Bearer $INTERNAL_CRON_SECRET`. */
export function cronAuthorized(req: Request): boolean {
  const secret = env().INTERNAL_CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return !!secret && provided.length === secret.length && timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}
