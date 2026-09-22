import { z } from 'zod';
import { getDb } from '@/lib/db';
import { adminRoute } from '@/lib/admin/api';
import { loadSwitches, setKillSwitch } from '@/lib/email/send-gate';
import { audit } from '@/lib/util/audit';

export const dynamic = 'force-dynamic';
const Body = z.object({ key: z.string().regex(/^[a-z_:-]+$/), enabled: z.boolean(), reason: z.string().min(2).max(500) });

export async function GET(req: Request) {
  return adminRoute(req, {}, async () => Response.json(await loadSwitches((await getDb()).db)));
}

/** Kill switches are admin-only and take effect at the next dispatch gate evaluation (A38). */
export async function POST(req: Request) {
  return adminRoute(req, { role: 'admin', body: Body }, async ({ staff, body }) => {
    const { db } = await getDb();
    await setKillSwitch(db, body.key, body.enabled, staff.userId, body.reason);
    await audit(db, { actor: staff.userId, action: 'kill_switch.changed', entityKind: 'kill_switch', entityId: body.key, diff: { enabled: body.enabled, reason: body.reason } });
    return Response.json({ ok: true });
  });
}
