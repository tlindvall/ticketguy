import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { env } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { db, driver } = await getDb();
    await db.execute(sql`select 1`);
    const e = env();
    return Response.json({ ok: true, driver, appMode: e.APP_MODE, emailSendEnabled: e.EMAIL_SEND_ENABLED }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.name : 'error' }, { status: 503 });
  }
}
