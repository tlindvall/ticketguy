import { getDb } from '@/lib/db';
import { testAgentRoute } from '@/lib/admin/test-api';
import { recentTestRequests, testModeOn } from '@/lib/email/test-mode';

export const dynamic = 'force-dynamic';

/** GET /api/test/requests — whether test mode is on, and the latest test requests, newest first. */
export async function GET(req: Request) {
  return testAgentRoute(req, {}, async () => {
    const { db } = await getDb();
    const requests = await recentTestRequests(db, 50);
    return Response.json({ testMode: await testModeOn(db), requests: requests.map((r) => ({ ...r, at: r.at.toISOString() })) });
  });
}
