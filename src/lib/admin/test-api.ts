import { z } from 'zod';
import { env } from '@/lib/config/env';
import { testAgentAuthorized } from '@/lib/util/cron-auth';

/**
 * Wrapper for the test-mode customer API (/api/test/*). Bearer `TEST_AGENT_TOKEN`, no session: the caller is a
 * testing agent, not staff. 404 while no token is configured, so the API does not exist until someone sets one.
 */
export async function testAgentRoute<T = undefined>(req: Request, opts: { body?: z.ZodType<T>; maxBytes?: number }, fn: (ctx: { body: T }) => Promise<Response>): Promise<Response> {
  if (!env().TEST_AGENT_TOKEN) return Response.json({ error: 'not_found' }, { status: 404 });
  if (!testAgentAuthorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    let body = undefined as unknown as T;
    if (opts.body) {
      const raw = await req.text();
      if (raw.length > (opts.maxBytes ?? 64 * 1024)) return Response.json({ error: 'payload_too_large' }, { status: 413 });
      let json: unknown;
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch {
        return Response.json({ error: 'invalid_json' }, { status: 422 });
      }
      const parsed = opts.body.safeParse(json);
      if (!parsed.success) return Response.json({ error: 'validation', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, { status: 422 });
      body = parsed.data;
    }
    return await fn({ body });
  } catch (e) {
    console.error('[test-api]', e instanceof Error ? e.message : e);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
