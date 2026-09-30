import { testAgentRoute } from '@/lib/admin/test-api';
import { testTranscript } from '@/lib/admin/test-inbox';

export const dynamic = 'force-dynamic';

/** GET /api/test/requests/{id} — the thread as the test customer would have seen it. Test conversations only (404 otherwise). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return testAgentRoute(req, {}, async () => {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'not_found' }, { status: 404 });
    const transcript = await testTranscript(id);
    return transcript ? Response.json(transcript) : Response.json({ error: 'not_found' }, { status: 404 });
  });
}
