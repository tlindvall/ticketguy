import { z } from 'zod';
import { requireStaff, assertSameOrigin, authErrorResponse, type StaffRole } from '@/lib/auth/require-staff';

/** Shared wrapper for /api/admin routes: auth + role + origin check + size-limited JSON body + typed errors. */
export async function adminRoute<T = undefined>(req: Request, opts: { role?: StaffRole; body?: z.ZodType<T>; maxBytes?: number }, fn: (ctx: { staff: Awaited<ReturnType<typeof requireStaff>>; body: T }) => Promise<Response>): Promise<Response> {
  try {
    const staff = await requireStaff(opts.role ?? 'reviewer');
    if (req.method !== 'GET') assertSameOrigin(req);
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
    return await fn({ staff, body });
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    console.error('[admin-route]', e instanceof Error ? e.message : e);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
