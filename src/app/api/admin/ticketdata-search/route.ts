import { adminRoute } from '@/lib/admin/api';
import { env } from '@/lib/config/env';
import { ticketDataClient } from '@/lib/market/ticketdata-sync';

export const dynamic = 'force-dynamic';

/** Staff-only TicketData event lookup for enrollment (admin). No API key needed; the public API is keyless. */
export async function GET(req: Request) {
  return adminRoute(req, { role: 'admin' }, async () => {
    const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
    if (q.length < 2) return Response.json({ error: 'query_too_short' }, { status: 422 });
    const e = env();
    if (!e.TICKETDATA_ENABLED) return Response.json({ error: 'ticketdata_disabled' }, { status: 409 });
    const client = ticketDataClient(e);
    const suggestions = await client.searchSuggestions(q);
    return Response.json({ suggestions }, { headers: { 'cache-control': 'no-store' } });
  });
}
