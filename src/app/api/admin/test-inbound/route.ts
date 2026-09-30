import { adminRoute } from '@/lib/admin/api';
import { injectTestMessage, TestMessageBody, TEST_MESSAGE_MAX_BYTES } from '@/lib/admin/test-inbox';

export const dynamic = 'force-dynamic';

/** POST — staff write in as a test customer from the Test mode page or a request page. Test mode must be on. */
export async function POST(req: Request) {
  return adminRoute(req, { body: TestMessageBody, maxBytes: TEST_MESSAGE_MAX_BYTES }, async ({ staff, body }) => {
    const r = await injectTestMessage(body, staff.userId);
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    return Response.json({ outcome: r.outcome.kind, requestId: r.requestId }, { status: 202 });
  });
}
