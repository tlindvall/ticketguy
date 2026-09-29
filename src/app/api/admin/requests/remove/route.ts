import { z } from 'zod';
import { getDb } from '@/lib/db';
import { adminRoute } from '@/lib/admin/api';
import { removeRequests } from '@/lib/admin/remove-requests';

export const dynamic = 'force-dynamic';
const Body = z.object({ requestIds: z.array(z.string().uuid()).min(1).max(200) });

/** POST — take requests off the board (closed as removed by staff; nothing deleted, nothing further sent). */
export async function POST(req: Request) {
  return adminRoute(req, { body: Body }, async ({ staff, body }) => {
    const { db } = await getDb();
    const res = await db.transaction((tx) => removeRequests(tx, { requestIds: body.requestIds, staffUserId: staff.userId, now: new Date() }));
    return Response.json(res);
  });
}
