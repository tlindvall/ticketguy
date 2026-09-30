import { env } from '@/lib/config/env';
import { testAgentRoute } from '@/lib/admin/test-api';
import { injectTestMessage, TestMessageBody, TEST_MESSAGE_MAX_BYTES } from '@/lib/admin/test-inbox';

export const dynamic = 'force-dynamic';

/**
 * POST /api/test/inbound — a testing agent writes in as a customer (a new request, or a reply with
 * `replyToRequestId`). Refused with 409 unless an admin has test mode on. Poll /api/test/requests/{requestId}
 * for what came back.
 */
export async function POST(req: Request) {
  return testAgentRoute(req, { body: TestMessageBody, maxBytes: TEST_MESSAGE_MAX_BYTES }, async ({ body }) => {
    const r = await injectTestMessage(body, 'test_agent');
    if (!r.ok) return Response.json({ error: r.error, ...(r.error === 'test_mode_off' ? { message: 'An admin has to turn test mode on at /admin/test first.' } : {}) }, { status: r.status });
    const base = env().APP_URL.replace(/\/$/, '');
    return Response.json({
      outcome: r.outcome.kind,
      requestId: r.requestId,
      newThread: r.outcome.kind === 'queued' ? r.outcome.isNewConversation : null,
      statusUrl: r.requestId ? `${base}/api/test/requests/${r.requestId}` : null,
      adminUrl: r.requestId ? `${base}/admin/requests/${r.requestId}` : null,
    }, { status: 202 });
  });
}
