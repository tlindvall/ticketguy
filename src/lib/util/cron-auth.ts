import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';

function bearerMatches(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  // Compared as bytes: equal string lengths can still differ in byte length, which timingSafeEqual throws on.
  const provided = Buffer.from(req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Scheduler endpoints (Render cron or Inngest) authenticate with `Authorization: Bearer $INTERNAL_CRON_SECRET`. */
export function cronAuthorized(req: Request): boolean {
  return bearerMatches(req, env().INTERNAL_CRON_SECRET);
}

/** The test-mode customer API authenticates with `Authorization: Bearer $TEST_AGENT_TOKEN`. */
export function testAgentAuthorized(req: Request): boolean {
  return bearerMatches(req, env().TEST_AGENT_TOKEN);
}
